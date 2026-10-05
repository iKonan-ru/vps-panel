package dockerapi

import "testing"

// Свой транспорт на каждый New() копил keep-alive соединения и горутины (снимок раз в 5 минут).
func TestNewSharesTransport(t *testing.T) {
	if New().http.Transport != New().http.Transport {
		t.Fatal("каждый New() создаёт свой транспорт")
	}
	if transport.IdleConnTimeout == 0 {
		t.Fatal("у транспорта нет IdleConnTimeout")
	}
}
