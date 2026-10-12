package reach

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const measured = `{"status":"finished","results":[
 {"probe":{"city":"Tomsk","asn":31357,"network":"Info"},"result":{"status":"finished","tls":{"protocol":"TLSv1.3"},"stats":{"rcv":3}}},
 {"probe":{"city":"Samara","asn":3216,"network":"Vimpelcom"},"result":{"status":"finished","tls":null,"rawOutput":"HEAD / HTTP/1.1\nconnect ETIMEDOUT 1.2.3.4:443"}},
 {"result":{"status":"failed","rawOutput":"connect ETIMEDOUT 1.2.3.4:443"}},
 {"result":{"status":"finished","tls":{"protocol":"TLSv1.3"},"stats":{"rcv":0}}},
 {"result":{"status":"in-progress"}}
]}`

func TestParse(t *testing.T) {
	r := Parse("tls", []byte(measured))
	if r.Total != 4 || r.OK != 2 || r.Percent != 50 {
		t.Fatalf("tls: %+v", r)
	}
	if len(r.Errors) != 1 || r.Errors[0] != "connect ETIMEDOUT 1.2.3.4:443" {
		t.Fatalf("ошибки без повторов, последняя строка: %q", r.Errors)
	}
	if len(r.Probes) != 4 || !r.Probes[0].OK || r.Probes[0].City != "Tomsk" || r.Probes[0].ASN != 31357 {
		t.Fatalf("зонды: %+v", r.Probes)
	}
	if p := r.Probes[1]; p.OK || p.Network != "Vimpelcom" || p.Error != "connect ETIMEDOUT 1.2.3.4:443" {
		t.Fatalf("не дошедший зонд: %+v", p)
	}
	r = Parse("tcp", []byte(measured))
	if r.Total != 4 || r.OK != 1 {
		t.Fatalf("tcp: %+v", r)
	}
	if r := Parse("tcp", []byte(`{"results":[]}`)); r.Error == "" {
		t.Fatal("без зондов - ошибка проверки")
	}
}

func TestCheck(t *testing.T) {
	pollEvery, waitFor = 10*time.Millisecond, time.Second
	var posts atomic.Int32
	var bodies []map[string]any
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			n := posts.Add(1)
			var b map[string]any
			_ = json.NewDecoder(r.Body).Decode(&b)
			bodies = append(bodies, b)
			if r.Header.Get("Authorization") != "Bearer tok" {
				t.Errorf("нет токена")
			}
			if n == 3 {
				w.Header().Set("X-RateLimit-Reset", "600")
				w.WriteHeader(http.StatusTooManyRequests)
				return
			}
			w.Header().Set("X-RateLimit-Remaining", "180")
			w.WriteHeader(http.StatusAccepted)
			_, _ = w.Write([]byte(`{"id":"m` + string(rune('0'+n)) + `","probesCount":5}`))
			return
		}
		if !strings.HasPrefix(r.URL.Path, "/measurements/m") {
			t.Errorf("путь %s", r.URL.Path)
		}
		_, _ = w.Write([]byte(measured))
	}))
	defer srv.Close()
	API = srv.URL
	rep, err := Check(context.Background(), Params{Token: "tok", Probes: 5, Targets: []Target{
		{Key: "ip", Kind: "tcp", Host: "1.2.3.4", Port: 22},
		{Key: "xui:1", Kind: "tls", Host: "1.2.3.4", Port: 443, SNI: "example.com"},
		{Key: "xui:2", Kind: "tls", Host: "1.2.3.4", Port: 8443},
		{Key: "xui:3", Kind: "tcp", Host: "1.2.3.4", Port: 9000},
	}})
	if err != nil {
		t.Fatal(err)
	}
	if rep.Remaining != 0 || posts.Load() != 3 {
		t.Fatalf("после 429 больше не заказывает: остаток %d, заказов %d", rep.Remaining, posts.Load())
	}
	if rep.Results[0].OK != 1 || rep.Results[1].OK != 2 {
		t.Fatalf("итоги: %+v", rep.Results)
	}
	for _, i := range []int{2, 3} {
		if !strings.Contains(rep.Results[i].Error, "квота Globalping") || !strings.Contains(rep.Results[i].Error, "10\u00a0мин") {
			t.Fatalf("цель %d: %q", i, rep.Results[i].Error)
		}
	}
	opts := bodies[1]["measurementOptions"].(map[string]any)
	if opts["protocol"] != "HTTPS" || opts["request"].(map[string]any)["host"] != "example.com" {
		t.Fatalf("tls с SNI: %v", opts)
	}
	if bodies[0]["type"] != "ping" {
		t.Fatalf("tcp - ping по TCP: %v", bodies[0])
	}
}

func TestValidate(t *testing.T) {
	bad := []Target{
		{Key: "a b", Kind: "tcp", Host: "1.2.3.4", Port: 22},
		{Key: "a", Kind: "udp", Host: "1.2.3.4", Port: 22},
		{Key: "a", Kind: "tcp", Host: "1.2.3.4;rm", Port: 22},
		{Key: "a", Kind: "tcp", Host: "1.2.3.4", Port: 0},
	}
	for _, x := range bad {
		if _, err := Check(context.Background(), Params{Targets: []Target{x}}); err == nil {
			t.Fatalf("должна быть ошибка: %+v", x)
		}
	}
}
