package lockout

import (
	"slices"
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestKnownProcessesDefault(t *testing.T) {
	want := []string{"sshd", "xray*", "x-ui", "telemt", "mtproxyl*", "wdtt*", "amnezia*", "awg*", "wg*", "sing-box", "hysteria*", "tuic*", "vps-agent", "caddy", "docker-proxy"}
	if got := KnownProcesses(); !slices.Equal(got, want) {
		t.Fatalf("known_processes по умолчанию: %v", got)
	}
}

func TestIsVPNProcess(t *testing.T) {
	for _, p := range []string{"xray-linux-amd64", "x-ui", "telemt", "mtproxyl-panel", "wdtt-server", "amneziawg-go", "awg", "wg-crypt-wg0", "sing-box", "hysteria", "tuic-server", "openvpn", "ck-server-cloak"} {
		if !IsVPNProcess(p) {
			t.Errorf("%s - VPN", p)
		}
	}
	for _, p := range []string{"sshd", "nginx", "node", "caddy", "vps-agent"} {
		if IsVPNProcess(p) {
			t.Errorf("%s - не VPN", p)
		}
	}
}

func TestPasswordsAndKeys(t *testing.T) {
	if DisablePasswords(0) == nil || DisablePasswords(1) != nil {
		t.Fatal("пароли отключаются только при ключах root")
	}
	if RemoveKey(0, false) == nil || RemoveKey(0, true) != nil || RemoveKey(1, false) != nil {
		t.Fatal("последний ключ удаляется только при входе по паролю")
	}
}

func TestClosingVPN(t *testing.T) {
	ls := []proto.Listener{
		{Proto: "tcp", Port: 443, Process: "xray-linux-amd64"},
		{Proto: "udp", Port: 51820, Process: "wdtt-server"},
		{Proto: "tcp", Port: 9090, Process: "telemt"},
		{Proto: "tcp", Port: 8443, Process: "telemt"},
		{Proto: "tcp", Port: 3000, Process: "node"},
		{Proto: "tcp", Port: 8080, Process: "docker-proxy"},
	}
	got := ClosingVPN(ls, map[string]bool{"443/tcp": true}, map[string]bool{"9090/tcp": true}, map[string]bool{"8443/tcp": true})
	if len(got) != 1 || !strings.Contains(got[0], "51820/udp") || !strings.Contains(got[0], "wdtt-server") {
		t.Fatalf("закроется только порт WDTT, получено %q", got)
	}
}
