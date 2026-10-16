// Package transport держит websocket-соединение с панелью и переподключается.
package transport

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Handler обрабатывает запрос панели и возвращает результат или ошибку.
type Handler func(ctx context.Context, method string, params json.RawMessage, stream func(channel, chunk string)) (any, error)

// maxMessage - потолок одного сообщения панели: больше панель не шлёт.
const maxMessage = 16 << 20

type Client struct {
	url     string
	token   string
	hello   any
	handler Handler
	log     *slog.Logger

	panelKey ed25519.PublicKey

	mu   sync.Mutex
	conn *websocket.Conn
	ch   *channel
	// OnWelcome вызывается после проверенного welcome (serverId, protocol, постоянный токен -
	// при регистрации: его создаёт сам агент, панель получает только хеш).
	OnWelcome func(serverID, protocol, token string)
	// OnDisconnect - соединение с панелью оборвалось: то, что живёт только пока панель на
	// связи (сессии веб-терминала, туннели), закрывается - закрыть его потом уже некому.
	OnDisconnect func()
	// Methods - операции агента, уходят в hello: панель не зовёт то, чего агент не умеет.
	Methods []string
	// Inline - операции, которые выполняются прямо в цикле чтения, по порядку прихода (запись в
	// туннель): в отдельных горутинах куски потока могли бы переставиться.
	Inline map[string]bool
	// AfterResult - успешный результат операции ушёл панели.
	AfterResult func(method string, data any)
}

// New - клиент панели. panelKey - ключ панели из конфига: другой панели агент не поверит.
func New(panelURL, token string, panelKey ed25519.PublicKey, hello any, h Handler, log *slog.Logger) *Client {
	ws := strings.Replace(strings.Replace(panelURL, "https://", "wss://", 1), "http://", "ws://", 1)
	return &Client{url: strings.TrimRight(ws, "/") + "/ws/agent?v=2", token: token, panelKey: panelKey, hello: hello, handler: h, log: log}
}

type request struct {
	Type   string          `json:"type"`
	ID     string          `json:"id"`
	Method string          `json:"method"`
	Params json.RawMessage `json:"params"`
	// welcome
	ServerID string `json:"serverId"`
	Protocol string `json:"protocol"`
	Proof    string `json:"proof"`
}

// Run держит соединение до отмены контекста, с экспоненциальной паузой между попытками.
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	for {
		started := time.Now()
		err := c.session(ctx)
		if ctx.Err() != nil {
			return
		}
		// Сессия жила достаточно долго - обрыв случайный, повторяем быстро.
		if time.Since(started) > time.Minute {
			backoff = time.Second
		}
		c.log.Warn("connection lost", "err", err, "retry_in", backoff)
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

// handshake - рукопожатие v2 (secure.go): ключ панели, канал, доказательство токена, hello.
// Возвращает канал, стенограмму и хеш учётных данных (для проверки welcome).
func (c *Client) handshake(conn *websocket.Conn, tok string) (*channel, []byte, string, string, error) {
	priv, err := ecdh.X25519().GenerateKey(rand.Reader)
	if err != nil {
		return nil, nil, "", "", err
	}
	_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	if err := conn.WriteJSON(map[string]any{"type": "hello2", "eph": base64.StdEncoding.EncodeToString(priv.PublicKey().Bytes())}); err != nil {
		return nil, nil, "", "", err
	}
	_ = conn.SetReadDeadline(time.Now().Add(15 * time.Second))
	mt, data, err := conn.ReadMessage()
	if err != nil {
		return nil, nil, "", "", err
	}
	var sh struct {
		Type string `json:"type"`
		Eph  string `json:"eph"`
		Key  string `json:"key"`
		Sig  string `json:"sig"`
	}
	if mt != websocket.TextMessage || json.Unmarshal(data, &sh) != nil || sh.Type != "server-hello" {
		return nil, nil, "", "", errors.New("панель ответила не по протоколу v2")
	}
	ch, th, err := verifyServerHello(priv, c.panelKey, sh.Eph, sh.Key, sh.Sig)
	if err != nil {
		return nil, nil, "", "", err
	}
	auth := map[string]any{"type": "auth"}
	var credHash, newToken string
	if reg, ok := strings.CutPrefix(tok, "reg:"); ok {
		// постоянный токен создаёт сам агент: панель получает только его хеш
		b := make([]byte, 32)
		if _, err := rand.Read(b); err != nil {
			return nil, nil, "", "", err
		}
		newToken = base64.RawURLEncoding.EncodeToString(b)
		credHash = TokenHash(reg)
		auth["reg"] = true
		auth["tokenHash"] = TokenHash(newToken)
	} else {
		credHash = TokenHash(tok)
	}
	auth["proof"] = proof(credHash, "agent", th)
	for _, m := range []any{auth, map[string]any{"type": "hello", "protocol": "1.0", "host": c.hello, "methods": c.Methods}} {
		b, err := json.Marshal(m)
		if err != nil {
			return nil, nil, "", "", err
		}
		_ = conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
		if err := conn.WriteMessage(websocket.BinaryMessage, ch.seal(b)); err != nil {
			return nil, nil, "", "", err
		}
	}
	return ch, th, credHash, newToken, nil
}

func (c *Client) session(ctx context.Context) error {
	if len(c.panelKey) != ed25519.PublicKeySize {
		return errors.New("ключ панели не задан - соединение не устанавливается")
	}
	c.mu.Lock()
	tok := c.token
	c.mu.Unlock()
	d := websocket.Dialer{HandshakeTimeout: 15 * time.Second}
	conn, resp, err := d.DialContext(ctx, c.url, nil)
	if err != nil {
		if resp != nil {
			return errors.New("dial: " + resp.Status)
		}
		return err
	}
	defer conn.Close()
	conn.SetReadLimit(maxMessage)
	ch, th, credHash, newToken, err := c.handshake(conn, tok)
	if err != nil {
		return err
	}
	defer func() {
		c.mu.Lock()
		c.conn, c.ch = nil, nil
		c.mu.Unlock()
		if c.OnDisconnect != nil {
			c.OnDisconnect()
		}
	}()
	c.mu.Lock()
	c.conn, c.ch = conn, ch
	c.mu.Unlock()
	c.log.Info("connected", "url", c.url)

	conn.SetPongHandler(func(string) error { return conn.SetReadDeadline(time.Now().Add(90 * time.Second)) })
	_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))

	// Пинг раз в 30 с: панель отвечает pong, и дедлайн чтения сдвигается.
	// Без этого тихое соединение рвётся через 90 с (панель шлёт только запросы).
	pingCtx, stopPing := context.WithCancel(ctx)
	defer stopPing()
	// SIGTERM (ctx отменён): закрываем сокет, иначе ReadMessage висит до kill по таймауту systemd.
	go func() {
		<-pingCtx.Done()
		if ctx.Err() != nil {
			_ = conn.Close()
		}
	}()
	go func() {
		t := time.NewTicker(30 * time.Second)
		defer t.Stop()
		for {
			select {
			case <-pingCtx.Done():
				return
			case <-t.C:
				if err := conn.WriteControl(websocket.PingMessage, nil, time.Now().Add(10*time.Second)); err != nil {
					return
				}
			}
		}
	}()

	// До проверенного welcome запросы не выполняются: панель ещё не доказала знание токена.
	welcomed := false
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		_ = conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		if mt != websocket.BinaryMessage {
			return errors.New("открытое сообщение в зашифрованном канале")
		}
		// читает только эта горутина, а Send не трогает счётчик приёма
		plain, err := ch.open(data)
		if err != nil {
			return err
		}
		var req request
		if err := json.Unmarshal(plain, &req); err != nil {
			c.log.Warn("bad message", "err", err)
			continue
		}
		switch req.Type {
		case "welcome":
			if !hmac.Equal([]byte(req.Proof), []byte(proof(credHash, "panel", th))) {
				return errors.New("панель не подтвердила токен агента - соединение отклонено")
			}
			welcomed = true
			if newToken != "" {
				c.SetToken(newToken)
			}
			if c.OnWelcome != nil {
				c.OnWelcome(req.ServerID, req.Protocol, newToken)
			}
		case "request":
			if !welcomed {
				return errors.New("запрос панели до welcome")
			}
			if c.Inline[req.Method] {
				c.handle(ctx, req)
			} else {
				go c.handle(ctx, req)
			}
		}
	}
}

func (c *Client) handle(ctx context.Context, req request) {
	stream := func(channel, chunk string) {
		_ = c.Send(map[string]any{"type": "stream", "id": req.ID, "channel": channel, "chunk": chunk})
	}
	data, err := c.call(ctx, req, stream)
	msg := map[string]any{"type": "result", "id": req.ID, "ok": err == nil}
	if err != nil {
		msg["error"] = err.Error()
	} else {
		msg["data"] = data
	}
	if c.Send(msg) == nil && err == nil && c.AfterResult != nil {
		c.AfterResult(req.Method, data)
	}
}

// Connected - есть ли сейчас соединение с панелью.
func (c *Client) Connected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.conn != nil && c.ch != nil
}

// call - вызов обработчика с перехватом паники: разбор вывода CLI с [0] и т.п. в одной
// операции не должен ронять агента вместе со всеми операциями в работе.
func (c *Client) call(ctx context.Context, req request, stream func(channel, chunk string)) (data any, err error) {
	defer func() {
		if r := recover(); r != nil {
			c.log.Error("panic in handler", "method", req.Method, "panic", r, "stack", string(debug.Stack()))
			data, err = nil, fmt.Errorf("внутренняя ошибка агента в %s: %v", req.Method, r)
		}
	}()
	return c.handler(ctx, req.Method, req.Params, stream)
}

// SetToken меняет токен для следующих подключений (после регистрации).
func (c *Client) SetToken(t string) {
	c.mu.Lock()
	c.token = t
	c.mu.Unlock()
}

// Send сериализует сообщение, шифрует и пишет его в соединение (потокобезопасно).
func (c *Client) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.conn == nil || c.ch == nil {
		return errors.New("not connected")
	}
	_ = c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
	return c.conn.WriteMessage(websocket.BinaryMessage, c.ch.seal(b))
}
