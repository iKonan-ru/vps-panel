package baseline

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
)

// Сервер с port-sync прошлой версии: агент обновляет скрипт и юниты, ставит службу проверки
// для vps-portsync-xui.path, перечитывает юниты и перезапускает path-юнит.
func TestRefreshPortsyncInstallsCheckService(t *testing.T) {
	root := t.TempDir()
	old := hostfs.Root
	hostfs.Root = root
	defer func() { hostfs.Root = old }()
	var calls []string
	oldCtl := systemctl
	systemctl = func(_ context.Context, script string) { calls = append(calls, script) }
	defer func() { systemctl = oldCtl }()
	ctx := context.Background()

	if changed, err := RefreshPortsync(ctx); changed || err != nil || len(calls) > 0 {
		t.Fatalf("port-sync не установлен: %v %v %q", changed, err, calls)
	}
	units := filepath.Join(root, "etc/systemd/system")
	for _, d := range []string{units, filepath.Join(root, "usr/local/sbin")} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	write := func(p, s string) {
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write(filepath.Join(root, portsyncBin), "#!/usr/bin/env python3\n# прежний скрипт\n")
	write(filepath.Join(units, "vps-portsync.service"), "старый\n")
	timer, _ := assets.ReadFile("assets/portsync.timer")
	write(filepath.Join(units, "vps-portsync.timer"), string(timer))
	write(filepath.Join(units, "vps-portsync-xui.path"), "[Path]\nPathModified=/etc/x-ui/x-ui.db\nUnit=vps-portsync.service\n")

	changed, err := RefreshPortsync(ctx)
	if err != nil || !changed {
		t.Fatalf("ждали обновление: %v %v", changed, err)
	}
	for unit, a := range map[string]string{"vps-portsync.service": "portsync.service", "vps-portsync-xui.path": "portsync-xui.path",
		"vps-portsync-xui.service": "portsync-xui.service", "vps-portsync.timer": "portsync.timer"} {
		got, err := os.ReadFile(filepath.Join(units, unit))
		want, _ := assets.ReadFile("assets/" + a)
		if err != nil || string(got) != string(want) {
			t.Errorf("%s не обновлён: %v", unit, err)
		}
	}
	if _, err := os.Stat(filepath.Join(units, "vps-portsync-docker-watch.service")); err == nil {
		t.Error("docker-watch не был установлен - и не должен появиться")
	}
	script, _ := os.ReadFile(filepath.Join(root, portsyncBin))
	if !strings.Contains(string(script), "-portsync-state") {
		t.Error("скрипт не обновлён")
	}
	if len(calls) != 2 || calls[0] != "systemctl daemon-reload" || !strings.Contains(calls[1], "&& true;") ||
		!strings.Contains(calls[1], "systemctl restart vps-portsync-xui.path") {
		t.Fatalf("вызовы systemctl: %q", calls)
	}

	// откат на прежний агент вернул свой скрипт и path-юнит, служба проверки осталась; снова
	// новый агент - всё как после обновления
	write(filepath.Join(root, portsyncBin), "#!/usr/bin/env python3\n# прежний скрипт\n")
	write(filepath.Join(units, "vps-portsync-xui.path"), "[Path]\nPathModified=/etc/x-ui/x-ui.db\nUnit=vps-portsync.service\n")
	calls = nil
	if changed, err := RefreshPortsync(ctx); err != nil || !changed {
		t.Fatalf("после отката: %v %v", changed, err)
	}
	if got, _ := os.ReadFile(filepath.Join(units, "vps-portsync-xui.path")); !strings.Contains(string(got), "Unit=vps-portsync-xui.service") {
		t.Fatal("после отката path-юнит не обновлён")
	}
	if len(calls) != 2 || calls[0] != "systemctl daemon-reload" || !strings.Contains(calls[1], "&& true;") {
		t.Fatalf("после отката, вызовы systemctl: %q", calls)
	}

	// всё уже обновлено: без daemon-reload, path-юнит - только если systemd его выключил
	calls = nil
	if changed, err := RefreshPortsync(ctx); changed || err != nil {
		t.Fatalf("повторно: %v %v", changed, err)
	}
	if len(calls) != 1 || !strings.Contains(calls[0], "! systemctl is-active --quiet vps-portsync-xui.path") {
		t.Fatalf("повторно, вызовы: %q", calls)
	}
}

func TestPlanConfig(t *testing.T) {
	root := t.TempDir()
	old := hostfs.Root
	hostfs.Root = root
	defer func() { hostfs.Root = old }()
	cfg, err := planConfig()
	if err != nil || len(cfg.DenyPublicPorts) != 3 {
		t.Fatalf("без конфига план - с тем, что запишет установка: %+v %v", cfg, err)
	}
	if err := os.MkdirAll(filepath.Join(root, "etc"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, portsyncConf), []byte(`{"extra_allow": [1,]}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := planConfig(); err == nil || !strings.Contains(err.Error(), "не разбирается") {
		t.Fatalf("битый конфиг: %v", err)
	}
}
