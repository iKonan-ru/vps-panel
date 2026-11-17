package baseline

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
)

// Адреса панели попадают в ignoreip нашего jail.local; чужой файл и сбой DNS его не меняют.
func TestRefreshFail2banIgnore(t *testing.T) {
	root := t.TempDir()
	oldRoot, oldURL, oldLookup, oldCtl := hostfs.Root, panelURL, lookupHost, systemctl
	defer func() { hostfs.Root, panelURL, lookupHost, systemctl = oldRoot, oldURL, oldLookup, oldCtl }()
	hostfs.Root = root
	var calls []string
	systemctl = func(_ context.Context, script string) { calls = append(calls, script) }
	answer, dnsErr := []string{"198.51.100.9", "127.0.0.1", "2001:db8::5", "198.51.100.9"}, error(nil)
	lookupHost = func(context.Context, string) ([]string, error) { return answer, dnsErr }
	SetPanelURL("https://panel.example.com")
	ctx := context.Background()

	if changed, err := RefreshFail2banIgnore(ctx); changed || err != nil {
		t.Fatalf("нет jail.local: %v %v", changed, err)
	}
	path := filepath.Join(root, jailLocal)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	foreign := "[DEFAULT]\nignoreip = 127.0.0.1/8\n"
	if err := os.WriteFile(path, []byte(foreign), 0o644); err != nil {
		t.Fatal(err)
	}
	if changed, _ := RefreshFail2banIgnore(ctx); changed {
		t.Fatal("чужой jail.local не трогается")
	}

	jail, _ := assets.ReadFile("assets/jail.local")
	if err := os.WriteFile(path, jail, 0o644); err != nil {
		t.Fatal(err)
	}
	changed, err := RefreshFail2banIgnore(ctx)
	if !changed || err != nil {
		t.Fatalf("наш jail.local: %v %v", changed, err)
	}
	got, _ := os.ReadFile(path)
	if !strings.Contains(string(got), "\nignoreip  = 127.0.0.1/8 ::1 198.51.100.9 2001:db8::5\n") {
		t.Fatalf("строка ignoreip:\n%s", got)
	}
	if strings.Count(string(got), "ignoreip") != 1 || !strings.Contains(string(got), "[sshd]") {
		t.Fatalf("остальное не меняется:\n%s", got)
	}
	if len(calls) != 1 || !strings.Contains(calls[0], "fail2ban-client reload") {
		t.Fatalf("fail2ban перечитан: %q", calls)
	}
	// повтор - без изменений и без reload
	if changed, _ := RefreshFail2banIgnore(ctx); changed || len(calls) != 1 {
		t.Fatalf("повтор: %v %q", changed, calls)
	}
	// DNS не ответил - прежние адреса остаются
	dnsErr = errors.New("no such host")
	if changed, _ := RefreshFail2banIgnore(ctx); changed {
		t.Fatal("сбой DNS не убирает адреса")
	}
	// адрес панели - IP: без DNS
	SetPanelURL("https://203.0.113.4:8443")
	if changed, _ := RefreshFail2banIgnore(ctx); !changed {
		t.Fatal("новый адрес панели")
	}
	got, _ = os.ReadFile(path)
	if !strings.Contains(string(got), "ignoreip  = 127.0.0.1/8 ::1 203.0.113.4\n") {
		t.Fatalf("адрес-IP:\n%s", got)
	}
}
