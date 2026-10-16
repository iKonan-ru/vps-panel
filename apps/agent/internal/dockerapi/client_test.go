package dockerapi

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewSharesTransport(t *testing.T) {
	if New().http.Transport != New().http.Transport {
		t.Fatal("каждый New() создаёт свой транспорт")
	}
	if transport.IdleConnTimeout == 0 {
		t.Fatal("у транспорта нет IdleConnTimeout")
	}
}

// fakeDocker - Docker Engine API на httptest: ответы по пути запроса.
func fakeDocker(t *testing.T, routes map[string]func(w http.ResponseWriter)) *Client {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if h, ok := routes[r.URL.Path]; ok {
			h(w)
			return
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(srv.Close)
	tr := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		var d net.Dialer
		return d.DialContext(ctx, "tcp", srv.Listener.Addr().String())
	}}
	return &Client{http: &http.Client{Transport: tr}}
}

func reply(code int, body string) func(w http.ResponseWriter) {
	return func(w http.ResponseWriter) {
		w.WriteHeader(code)
		_, _ = w.Write([]byte(body))
	}
}

func TestListReportsUnreadContainers(t *testing.T) {
	c := fakeDocker(t, map[string]func(http.ResponseWriter){
		"/containers/json":                  reply(200, `[{"Id":"aaaaaaaaaaaaaaaa","Status":"Up"},{"Id":"bbbbbbbbbbbbbbbb","Status":"Up"},{"Id":"cccccccccccccccc","Status":"Up"}]`),
		"/containers/aaaaaaaaaaaaaaaa/json": reply(200, `{"Id":"aaaaaaaaaaaaaaaa","Name":"/amnezia-awg2","State":{"Status":"running"}}`),
		"/containers/bbbbbbbbbbbbbbbb/json": reply(500, `{"message":"timeout"}`),
		"/containers/cccccccccccccccc/json": reply(404, `{"message":"No such container"}`),
	})
	list, err := c.List(context.Background())
	if err == nil || !strings.Contains(err.Error(), "bbbbbbbbbbbb") || strings.Contains(err.Error(), "cccccccccccc") {
		t.Fatalf("ждали ошибку только про контейнер b, получено %v", err)
	}
	if len(list) != 1 || list[0].Name != "amnezia-awg2" {
		t.Fatalf("прочитанные контейнеры: %+v", list)
	}
}

func TestListRemovedBetweenCalls(t *testing.T) {
	c := fakeDocker(t, map[string]func(http.ResponseWriter){
		"/containers/json":                  reply(200, `[{"Id":"cccccccccccccccc","Status":"Up"}]`),
		"/containers/cccccccccccccccc/json": reply(404, `{"message":"No such container"}`),
	})
	list, err := c.List(context.Background())
	if err != nil || len(list) != 0 {
		t.Fatalf("удалённый между запросами контейнер - не ошибка: %v %v", list, err)
	}
}
