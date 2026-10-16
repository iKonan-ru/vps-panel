package baseline

import (
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestClosingVPN(t *testing.T) {
	ls := []proto.Listener{
		{Proto: "tcp", Port: 443, Process: "xray-linux-amd64"},
		{Proto: "udp", Port: 51820, Process: "wdtt-server"},
		{Proto: "tcp", Port: 9090, Process: "telemt"},
		{Proto: "tcp", Port: 8443, Process: "telemt"},
		{Proto: "tcp", Port: 3000, Process: "node"},
		{Proto: "tcp", Port: 8080, Process: "docker-proxy"},
	}
	allowed := map[string]bool{"443/tcp": true}
	denied := deniedPorts(PortsyncConfig{DenyPublicPorts: []string{"9090"}})
	keep := map[string]bool{"8443/tcp": true}
	got := closingVPN(ls, allowed, denied, keep)
	if len(got) != 1 || !strings.Contains(got[0], "51820/udp") || !strings.Contains(got[0], "wdtt-server") {
		t.Fatalf("закроется только порт WDTT, получено %q", got)
	}
}

func TestAllowedByRulesWithoutPortsync(t *testing.T) {
	rules := []proto.FirewallRule{
		{Port: "443", Proto: "tcp", Source: "any", Action: "allow", Origin: "portsync"},
		{Port: "8443", Proto: "any", Source: "any", Action: "allow", Origin: "manual"},
		{Port: "22", Proto: "tcp", Source: "203.0.113.5", Action: "allow", Origin: "manual"},
	}
	keep := keepRules(rules)
	if keep["443/tcp"] || !keep["8443/tcp"] || !keep["8443/udp"] || keep["22/tcp"] {
		t.Fatalf("правила не port-sync: %v", keep)
	}
}
