package tunnel

import (
	"context"
	"encoding/base64"
	"io"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestTunnelEchoAndOrder(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	go func() {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		_, _ = io.Copy(c, c) // эхо
		c.Close()
	}()
	port := ln.Addr().(*net.TCPAddr).Port
	var gotMu sync.Mutex
	var got strings.Builder
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, err := Open(context.Background(), OpenParams{ID: "tunnel-test-1", Port: port}, func(_ context.Context, p int) bool { return p == port },
			func(channel, chunk string) {
				if channel != "data" {
					return
				}
				b, _ := base64.StdEncoding.DecodeString(chunk)
				gotMu.Lock()
				got.Write(b)
				gotMu.Unlock()
			})
		if err != nil {
			t.Error(err)
		}
	}()
	// ждём регистрацию потока
	for i := 0; i < 100; i++ {
		mu.Lock()
		_, ok := tunnels["tunnel-test-1"]
		mu.Unlock()
		if ok {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	want := ""
	for i := 0; i < 200; i++ {
		s := strings.Repeat(string(rune('a'+i%26)), 100)
		want += s
		if err := Write("tunnel-test-1", base64.StdEncoding.EncodeToString([]byte(s))); err != nil {
			t.Fatal(err)
		}
	}
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		gotMu.Lock()
		n := got.Len()
		gotMu.Unlock()
		if n == len(want) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	gotMu.Lock()
	if got.String() != want {
		t.Fatalf("эхо не совпало: %d из %d байт", got.Len(), len(want))
	}
	gotMu.Unlock()
	if !Close("tunnel-test-1") {
		t.Fatal("поток не нашёлся")
	}
	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("Open не вернулся после Close")
	}
}

func TestTunnelRefusesForeignPort(t *testing.T) {
	_, err := Open(context.Background(), OpenParams{ID: "tunnel-test-2", Port: 22}, func(context.Context, int) bool { return false }, func(string, string) {})
	if err == nil {
		t.Fatal("порт не из списка панелей должен отклоняться")
	}
	if _, err := Open(context.Background(), OpenParams{ID: "x", Port: 22}, func(context.Context, int) bool { return true }, func(string, string) {}); err == nil {
		t.Fatal("короткий id должен отклоняться")
	}
}
