// Package terminal - веб-терминал: bash в pty, вывод уходит стримом открытого запроса
// term.open, ввод и размер приходят отдельными запросами term.input / term.resize по id сессии.
package terminal

import (
	"context"
	"encoding/base64"
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/creack/pty"
)

type session struct {
	pty    *os.File
	cmd    *exec.Cmd
	cancel context.CancelFunc
}

var (
	mu       sync.Mutex
	sessions = map[string]*session{}
)

// OpenParams - параметры term.open.
type OpenParams struct {
	ID   string `json:"id"`
	Cols uint16 `json:"cols"`
	Rows uint16 `json:"rows"`
}

// Open запускает bash в pty и держит запрос открытым, пока сессия жива: вывод идёт в stream
// (канал "data", base64). Возвращается, когда оболочка завершилась или запрос отменён.
func Open(ctx context.Context, p OpenParams, stream func(channel, chunk string)) (map[string]any, error) {
	if p.ID == "" {
		return nil, errors.New("нужен id сессии")
	}
	if p.Cols == 0 || p.Rows == 0 {
		p.Cols, p.Rows = 120, 32
	}
	ctx, cancel := context.WithCancel(ctx)
	cmd := exec.CommandContext(ctx, "/bin/bash", "-l")
	home := "/root"
	if _, err := os.Stat(home); err != nil {
		home = os.Getenv("HOME")
	}
	cmd.Dir = home
	cmd.Env = append(os.Environ(), "TERM=xterm-256color", "HOME="+home, "LANG=C.UTF-8",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
	f, err := pty.StartWithSize(cmd, &pty.Winsize{Cols: p.Cols, Rows: p.Rows})
	if err != nil {
		cancel()
		return nil, err
	}
	s := &session{pty: f, cmd: cmd, cancel: cancel}
	mu.Lock()
	if old := sessions[p.ID]; old != nil {
		old.close()
	}
	sessions[p.ID] = s
	mu.Unlock()
	defer func() {
		mu.Lock()
		if sessions[p.ID] == s {
			delete(sessions, p.ID)
		}
		mu.Unlock()
		s.close()
	}()

	buf := make([]byte, 16*1024)
	for {
		n, err := f.Read(buf)
		if n > 0 {
			stream("data", base64.StdEncoding.EncodeToString(buf[:n]))
		}
		if err != nil {
			break // EIO - оболочка закрылась
		}
	}
	_ = cmd.Wait()
	code := 0
	if cmd.ProcessState != nil {
		code = cmd.ProcessState.ExitCode()
	}
	return map[string]any{"exitCode": code}, nil
}

func (s *session) close() {
	s.cancel()
	_ = s.pty.Close()
	if s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
	}
}

// Input пишет ввод (base64) в pty сессии.
func Input(id, data string) error {
	mu.Lock()
	s := sessions[id]
	mu.Unlock()
	if s == nil {
		return errors.New("сессия не найдена")
	}
	raw, err := base64.StdEncoding.DecodeString(data)
	if err != nil {
		return err
	}
	_ = s.pty.SetWriteDeadline(time.Now().Add(5 * time.Second))
	_, err = s.pty.Write(raw)
	return err
}

// Resize меняет размер окна pty.
func Resize(id string, cols, rows uint16) error {
	mu.Lock()
	s := sessions[id]
	mu.Unlock()
	if s == nil {
		return errors.New("сессия не найдена")
	}
	return pty.Setsize(s.pty, &pty.Winsize{Cols: cols, Rows: rows})
}

// Close завершает сессию (оболочка получает SIGKILL).
func Close(id string) bool {
	mu.Lock()
	s := sessions[id]
	delete(sessions, id)
	mu.Unlock()
	if s == nil {
		return false
	}
	s.close()
	return true
}

// CloseAll завершает все сессии: связь с панелью оборвалась, term.close уже никто не пришлёт,
// а bash от root в pty остался бы навсегда.
func CloseAll() {
	mu.Lock()
	all := sessions
	sessions = map[string]*session{}
	mu.Unlock()
	for _, s := range all {
		s.close()
	}
}
