package baseline

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

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

// Один сервер до включения ufw и при сохранении настроек уже включённого firewall.
func TestWdttPortGuard(t *testing.T) {
	for _, port := range []int{56001, 53123} {
		for _, active := range []bool{false, true} {
			for _, publicAllowed := range []bool{false, true} {
				t.Run(fmt.Sprintf("port=%d/active=%t/public=%t", port, active, publicAllowed), func(t *testing.T) {
					root := t.TempDir()
					old := hostfs.Root
					hostfs.Root = root
					t.Cleanup(func() { hostfs.Root = old })
					write := func(path, content string, mode os.FileMode) {
						t.Helper()
						if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
							t.Fatal(err)
						}
						if err := os.WriteFile(path, []byte(content), mode); err != nil {
							t.Fatal(err)
						}
					}
					write(filepath.Join(root, "etc/systemd/system/wdtt.service"), fmt.Sprintf("[Service]\nExecStart=/usr/local/bin/wdtt-server -listen 0.0.0.0:56000 -wg-port %d\n", port), 0o644)
					bin := filepath.Join(root, "bin")
					stub := func(name, body string) { write(filepath.Join(bin, name), "#!/bin/sh\n"+body+"\n", 0o755) }
					stub("ss", fmt.Sprintf("cat <<'EOF'\nudp UNCONN 0 0 0.0.0.0:56000 0.0.0.0:* users:((\"wdtt-server\",pid=10,fd=3))\nudp UNCONN 0 0 0.0.0.0:%d 0.0.0.0:* users:((\"wdtt-server\",pid=10,fd=4))\ntcp LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:((\"sshd\",pid=11,fd=3))\nEOF", port))
					stub("sshd", "printf 'port 22\\npasswordauthentication no\\npermitrootlogin prohibit-password\\n'")
					stub("systemctl", "exit 1")
					stub("iptables", "exit 0")
					stub("dpkg", "exit 0")
					status := "Status: inactive"
					if active {
						status = fmt.Sprintf("Status: active\n56000/udp ALLOW IN Anywhere # vps-portsync: WDTT\n%d/udp ALLOW IN Anywhere # vps-portsync: WDTT", port)
					}
					stub("ufw", "cat <<'EOF'\n"+status+"\nEOF")
					// Только заглушки и cat: команды теста не могут применить правила хоста.
					if err := os.Symlink("/bin/cat", filepath.Join(bin, "cat")); err != nil {
						t.Fatal(err)
					}
					t.Setenv("PATH", bin)
					cfg := DefaultPortsyncConfig()
					cfg.SSHPort = 22
					if !publicAllowed {
						cfg.KnownProcesses = []string{"sshd"}
					}
					if err := WritePortsyncConfig(cfg); err != nil {
						t.Fatal(err)
					}
					var blockers string
					if active {
						if err := ApplyPortsyncConfig(context.Background(), cfg); err != nil {
							blockers = err.Error()
						}
					} else {
						plan := MakePlan(context.Background())
						for _, step := range plan.Steps {
							if step.ID == "ufw" || step.ID == "portsync" {
								blockers += step.Blocker
							}
						}
					}
					if strings.Contains(blockers, fmt.Sprintf("%d/udp", port)) {
						t.Fatalf("внутренний порт WDTT не должен блокировать: %s", blockers)
					}
					if publicAllowed && blockers != "" {
						t.Fatalf("публичный порт разрешён: %s", blockers)
					}
					if !publicAllowed && !strings.Contains(blockers, "56000/udp") {
						t.Fatalf("закрытие публичного порта должно блокировать: %s", blockers)
					}
				})
			}
		}
	}
}
