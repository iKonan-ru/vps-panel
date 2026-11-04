package portsync

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestClosingVPNInternalWdtt(t *testing.T) {
	s := newStand(t, "full")
	s.dockerSocket(t)
	s.use(t)
	unit := filepath.Join(s.root, "etc/systemd/system/wdtt.service")
	must(t, os.WriteFile(unit, []byte("[Service]\nExecStart=/usr/local/bin/wdtt-server -listen :56000 --wg-port=53123\n"), 0o644))
	cfg := DefaultConfig()
	cfg.KnownProcesses = []string{"sshd"}
	cfg.DenyPublicPorts = []string{"9090", "53/udp"}
	st, err := Compute(context.Background(), cfg)
	must(t, err)
	if st.Allowed()["53123/udp"] || !st.Allowed()["22/tcp"] {
		t.Fatal("внутренний порт не открывается, SSH сохраняется")
	}
	// Проверка использует тот же снимок конфигурации, что и план правил.
	must(t, os.WriteFile(unit, []byte("[Service]\nExecStart=/usr/local/bin/wdtt-server -wg-port 56001\n"), 0o644))
	for _, tc := range []struct {
		name, proto, process string
		port                 int
		blocked              bool
	}{
		{"internal", "udp", "wdtt-server", 53123, false},
		{"public", "udp", "wdtt-server", 56000, true},
		{"other-protocol", "tcp", "wdtt-server", 53123, true},
		{"other-process", "udp", "openvpn", 53123, true},
		{"unknown-port", "udp", "wdtt-server", 56001, true},
		{"explicit-deny-tcp", "tcp", "telemt", 9090, false},
		{"explicit-deny-udp", "udp", "openvpn", 53, false},
		{"manual-rule", "tcp", "openvpn", 29999, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ls := []proto.Listener{{Proto: tc.proto, Port: tc.port, Process: tc.process}}
			got := st.ClosingVPN(ls, map[string]bool{"29999/tcp": true})
			if (len(got) > 0) != tc.blocked {
				t.Fatalf("блокировка=%t, получено %v", tc.blocked, got)
			}
		})
	}
	// Нет подтверждённой конфигурации - нет исключения по одному имени процесса.
	must(t, os.Remove(unit))
	st, err = Compute(context.Background(), cfg)
	must(t, err)
	got := st.ClosingVPN([]proto.Listener{{Proto: "udp", Port: 53123, Process: "wdtt-server"}}, nil)
	if len(got) != 1 || !strings.Contains(got[0], "53123/udp") {
		t.Fatalf("без конфигурации порт должен защищаться: %v", got)
	}
}
