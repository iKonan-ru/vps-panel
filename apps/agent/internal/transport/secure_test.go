package transport

import (
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fakePanel - сторона панели канала v2 для тестов (как routes/agent-ws.ts).
type fakePanel struct {
	key       ed25519.PrivateKey
	credHash  string // хеш токена, который панель знает
	badProof  bool   // welcome с неверным доказательством
	mu        sync.Mutex
	gotAuth   map[string]any
	gotResult chan map[string]any
}

func (f *fakePanel) auth() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.gotAuth
}

func (f *fakePanel) handler(t *testing.T) http.HandlerFunc {
	up := websocket.Upgrader{}
	return func(w http.ResponseWriter, r *http.Request) {
		conn, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		var h struct{ Type, Eph string }
		if err := conn.ReadJSON(&h); err != nil || h.Type != "hello2" {
			return
		}
		ephA, _ := base64.StdEncoding.DecodeString(h.Eph)
		priv, _ := ecdh.X25519().GenerateKey(rand.Reader)
		ephP := priv.PublicKey().Bytes()
		pub := f.key.Public().(ed25519.PublicKey)
		th := transcript(ephA, ephP, pub)
		_ = conn.WriteJSON(map[string]string{
			"type": "server-hello",
			"eph":  base64.StdEncoding.EncodeToString(ephP),
			"key":  base64.StdEncoding.EncodeToString(pub),
			"sig":  base64.StdEncoding.EncodeToString(ed25519.Sign(f.key, th)),
		})
		a, _ := ecdh.X25519().NewPublicKey(ephA)
		shared, _ := priv.ECDH(a)
		k, _ := hkdf.Key(sha256.New, shared, append(append([]byte{}, ephA...), ephP...), handshakeContext, 64)
		recv, _ := newGCM(k[:32])
		send, _ := newGCM(k[32:])
		ch := &channel{send: send, recv: recv}
		read := func() map[string]any {
			_, b, err := conn.ReadMessage()
			if err != nil {
				return nil
			}
			p, err := ch.open(b)
			if err != nil {
				t.Errorf("панель не расшифровала: %v", err)
				return nil
			}
			var m map[string]any
			_ = json.Unmarshal(p, &m)
			return m
		}
		write := func(m any) {
			b, _ := json.Marshal(m)
			_ = conn.WriteMessage(websocket.BinaryMessage, ch.seal(b))
		}
		auth := read()
		f.mu.Lock()
		f.gotAuth = auth
		f.mu.Unlock()
		if auth == nil || auth["proof"] != proof(f.credHash, "agent", th) {
			_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(4003, "bad token"))
			return
		}
		if hello := read(); hello == nil || hello["type"] != "hello" {
			return
		}
		pr := proof(f.credHash, "panel", th)
		if f.badProof {
			pr = proof("чужой", "panel", th)
		}
		write(map[string]any{"type": "welcome", "serverId": "s1", "protocol": "1.0", "proof": pr})
		write(map[string]any{"type": "request", "id": "r1", "method": "echo", "params": map[string]any{"x": 1}})
		for {
			m := read()
			if m == nil {
				return
			}
			if m["type"] == "result" {
				f.gotResult <- m
				return
			}
		}
	}
}

func run(t *testing.T, f *fakePanel, token string, pinned ed25519.PublicKey, setup ...func(*Client)) (*Client, chan string, chan error) {
	srv := httptest.NewServer(f.handler(t))
	t.Cleanup(srv.Close)
	welcome := make(chan string, 1)
	c := New(srv.URL, token, pinned, map[string]any{}, func(context.Context, string, json.RawMessage, func(string, string)) (any, error) {
		return map[string]any{"pong": true}, nil
	}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	c.OnWelcome = func(_, _ string, tok string) { welcome <- tok }
	for _, fn := range setup {
		fn(c)
	}
	errs := make(chan error, 1)
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		errs <- c.session(ctx)
	}()
	return c, welcome, errs
}

func TestRegistrationOverSecureChannel(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	f := &fakePanel{key: key, credHash: TokenHash("regtok"), gotResult: make(chan map[string]any, 1)}
	var savedKey ed25519.PublicKey
	_, welcome, _ := run(t, f, "reg:regtok", nil, func(c *Client) {
		c.OnPanelKey = func(k ed25519.PublicKey) { savedKey = k }
	})
	select {
	case tok := <-welcome:
		if tok == "" || f.auth()["tokenHash"] != TokenHash(tok) {
			t.Fatalf("панель должна получить хеш нового токена, а агент - сам токен")
		}
		if p, _ := f.auth()["proof"].(string); strings.Contains(p, "regtok") {
			t.Fatal("токен ушёл открытым")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("нет welcome")
	}
	select {
	case r := <-f.gotResult:
		if r["ok"] != true {
			t.Fatalf("запрос не выполнен: %v", r)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("нет ответа на запрос")
	}
	if savedKey == nil || !savedKey.Equal(key.Public()) {
		t.Fatal("ключ панели должен запомниться после проверенного welcome")
	}
}

func TestPinnedKeyMismatchRejected(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	other, _, _ := ed25519.GenerateKey(rand.Reader)
	f := &fakePanel{key: key, credHash: TokenHash("tok"), gotResult: make(chan map[string]any, 1)}
	_, _, errs := run(t, f, "tok", other)
	select {
	case err := <-errs:
		if err == nil || !strings.Contains(err.Error(), "ключ панели не совпал") {
			t.Fatalf("ожидался отказ по ключу, получено %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("сессия не завершилась")
	}
	if f.auth() != nil {
		t.Fatal("агент не должен ничего слать чужой панели")
	}
}

func TestWelcomeWithoutProofRejected(t *testing.T) {
	_, key, _ := ed25519.GenerateKey(rand.Reader)
	f := &fakePanel{key: key, credHash: TokenHash("tok"), badProof: true, gotResult: make(chan map[string]any, 1)}
	_, welcome, errs := run(t, f, "tok", nil)
	select {
	case err := <-errs:
		if err == nil || !strings.Contains(err.Error(), "не подтвердила токен") {
			t.Fatalf("ожидался отказ, получено %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("сессия не завершилась")
	}
	select {
	case <-welcome:
		t.Fatal("welcome без доказательства не принимается")
	case <-f.gotResult:
		t.Fatal("запрос не должен выполняться")
	default:
	}
}
