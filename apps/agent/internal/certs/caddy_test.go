package certs

import (
	"reflect"
	"testing"
)

func TestCaddyHosts(t *testing.T) {
	cfg := `{"srv0":{"listen":[":443"],"routes":[{"handle":[{"handler":"subroute","routes":[{"match":[{"path":["/x"]}]}]}],"match":[{"host":["panel.example.com"]}]},{"match":[{"host":["b.example","*.wild.example"]}]}]},"srv1":{"routes":[{"match":[{"host":["a.example","panel.example.com"]}]}]}}`
	got := caddyHosts(cfg)
	want := []string{"a.example", "b.example", "panel.example.com"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("hosts: %v, ждали %v", got, want)
	}
	if caddyHosts("not json") != nil {
		t.Fatal("мусор - пусто")
	}
}
