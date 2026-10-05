package services

import (
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestParseWdttListen(t *testing.T) {
	unit := "ExecStart=/usr/local/bin/wdtt-server -admin-listen 127.0.0.1:56010 -listen 0.0.0.0:56000 -wg-port 56001\n"
	if got := parseWdttListen(unit); got != 56000 {
		t.Fatalf("got %d", got)
	}
	if got := parseWdttListen("ExecStart=/usr/local/bin/wdtt-server -listen :56002"); got != 56002 {
		t.Fatalf("без адреса: got %d", got)
	}
	if got := parseWdttListen("ExecStart=/usr/local/bin/wdtt-server -admin-listen 127.0.0.1:1"); got != 0 {
		t.Fatalf("admin-listen принят за listen: %d", got)
	}
}

func TestServiceContainers(t *testing.T) {
	for name, want := range map[string]bool{
		"amnezia-awg2": true, "amnezia-awg2-42385": true, "wg-easy": true,
		"amnezia-panel": false, "mtproxyl": false, "nginx": false,
	} {
		if got := isServiceContainer(name); got != want {
			t.Errorf("%s: %v", name, got)
		}
	}
	if containerDown(proto.Container{State: "running"}) || !containerDown(proto.Container{State: "restarting"}) {
		t.Fatal("running - работает, restarting - нет")
	}
}

func TestMarkDown(t *testing.T) {
	s := proto.Service{Kind: "wdtt"}
	markDown(&s, true, "служба wdtt: failed")
	if s.Details["down"] != true || s.Details["downReason"] != "служба wdtt: failed" {
		t.Fatalf("%v", s.Details)
	}
	ok := proto.Service{Kind: "wdtt"}
	markDown(&ok, false, "служба wdtt: active")
	if ok.Details["down"] != false || ok.Details["downReason"] != nil {
		t.Fatalf("работающему сервису причина не нужна: %v", ok.Details)
	}
}
