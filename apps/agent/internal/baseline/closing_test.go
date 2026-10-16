package baseline

import (
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestDeniedPorts(t *testing.T) {
	d := deniedPorts(PortsyncConfig{DenyPublicPorts: []string{"9090", "53/udp"}})
	if !d["9090/tcp"] || !d["53/udp"] || len(d) != 2 {
		t.Fatalf("deny: %v", d)
	}
}

func TestKeepRules(t *testing.T) {
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
