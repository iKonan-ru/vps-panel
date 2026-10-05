// Package tunnel - поток от панели к панели сервиса на этом сервере (поддомены панелей): tunnel.open держит запрос открытым и отдаёт прочитанное стримом (канал "data", base64),
// tunnel.write пишет, tunnel.close закрывает. Только 127.0.0.1 и только порты панелей сервисов -
// панели 3X-UI и MTProxyL могут слушать только loopback, снаружи их нет совсем.
package tunnel

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net"
	"regexp"
	"strconv"
	"sync"
	"time"
)

// maxTunnels - потолок одновременных потоков (браузер держит до 6 на поддомен).
const maxTunnels = 64

type tunnel struct {
	conn net.Conn
	in   chan []byte
	done chan struct{}
	once sync.Once
}

func (t *tunnel) close() {
	t.once.Do(func() {
		close(t.done)
		_ = t.conn.Close()
	})
}

var (
	mu      sync.Mutex
	tunnels = map[string]*tunnel{}
	reID    = regexp.MustCompile(`^[A-Za-z0-9_-]{8,64}$`)
)

// OpenParams - параметры tunnel.open.
type OpenParams struct {
	ID   string `json:"id"`
	Port int    `json:"port"`
}

// Open соединяется с 127.0.0.1:port и держит запрос, пока поток жив. allowed - порт панели
// сервиса этого сервера (порты из инвентаря), иначе отказ.
func Open(ctx context.Context, p OpenParams, allowed func(ctx context.Context, port int) bool, stream func(channel, chunk string)) (map[string]any, error) {
	if !reID.MatchString(p.ID) {
		return nil, errors.New("неверный id туннеля")
	}
	if p.Port < 1 || p.Port > 65535 || !allowed(ctx, p.Port) {
		return nil, fmt.Errorf("порт %d - не панель сервиса на этом сервере", p.Port)
	}
	mu.Lock()
	n := len(tunnels)
	mu.Unlock()
	if n >= maxTunnels {
		return nil, errors.New("слишком много открытых туннелей")
	}
	d := net.Dialer{Timeout: 5 * time.Second}
	conn, err := d.DialContext(ctx, "tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p.Port)))
	if err != nil {
		return nil, err
	}
	t := &tunnel{conn: conn, in: make(chan []byte, 256), done: make(chan struct{})}
	mu.Lock()
	if old := tunnels[p.ID]; old != nil {
		old.close()
	}
	tunnels[p.ID] = t
	mu.Unlock()
	defer func() {
		mu.Lock()
		if tunnels[p.ID] == t {
			delete(tunnels, p.ID)
		}
		mu.Unlock()
		t.close()
	}()
	// поток зарегистрирован: панель может писать (до этого tunnel.write не нашёл бы поток)
	stream("log", "open")
	// запрос отменён (связь с панелью оборвалась) - закрыть поток
	go func() {
		select {
		case <-ctx.Done():
			t.close()
		case <-t.done:
		}
	}()
	// запись - своей горутиной по порядку прихода: tunnel.write только кладёт в очередь
	go func() {
		for {
			select {
			case <-t.done:
				return
			case b := <-t.in:
				_ = conn.SetWriteDeadline(time.Now().Add(30 * time.Second))
				if _, err := conn.Write(b); err != nil {
					t.close()
					return
				}
			}
		}
	}()
	var sent int64
	buf := make([]byte, 32*1024)
	for {
		k, err := conn.Read(buf)
		if k > 0 {
			sent += int64(k)
			stream("data", base64.StdEncoding.EncodeToString(buf[:k]))
		}
		if err != nil {
			break
		}
	}
	return map[string]any{"bytes": sent}, nil
}

// Write кладёт кусок (base64) в очередь записи потока. Вызывается прямо в цикле чтения
// транспорта (порядок кусков сохраняется), поэтому ждёт не дольше 10 с.
func Write(id, data string) error {
	mu.Lock()
	t := tunnels[id]
	mu.Unlock()
	if t == nil {
		return errors.New("туннель закрыт")
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return err
	}
	select {
	case t.in <- raw:
		return nil
	case <-t.done:
		return errors.New("туннель закрыт")
	case <-time.After(10 * time.Second):
		t.close()
		return errors.New("туннель не принимает данные")
	}
}

// Close закрывает поток.
func Close(id string) bool {
	mu.Lock()
	t := tunnels[id]
	delete(tunnels, id)
	mu.Unlock()
	if t == nil {
		return false
	}
	t.close()
	return true
}

// CloseAll - связь с панелью оборвалась: закрыть все потоки.
func CloseAll() {
	mu.Lock()
	all := tunnels
	tunnels = map[string]*tunnel{}
	mu.Unlock()
	for _, t := range all {
		t.close()
	}
}
