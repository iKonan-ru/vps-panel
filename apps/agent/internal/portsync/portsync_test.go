package portsync

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
)

func TestLabelText(t *testing.T) {
	for in, want := range map[string]string{
		"\U0001F1E9\U0001F1EA Германия: \"Reality\"": "Германия: Reality",
		"  a\tb  ": "a b",
		"Очень длинное имя inbound-а для проверки": "Очень длинное имя inbound-а",
	} {
		if got := labelText(in, 28); got != want {
			t.Errorf("%q: %q", in, got)
		}
	}
}

func TestFnmatch(t *testing.T) {
	for _, c := range []struct {
		name, pat string
		ok        bool
	}{
		{"xray-linux-amd6", "xray*", true}, {"x-ui", "x-ui", true}, {"x-uii", "x-ui", false},
		{"wg-crypt-wg0", "wg*", true}, {"awg", "wg*", false}, {"a.b", "a?b", true}, {"axb", "a.b", false},
		{"wg1", "wg[0-9]", true}, {"wgx", "wg[!0-9]", true}, {"wg1", "wg[!0-9]", false}, {"[x", "[x", true},
		{"", "*", true}, {"", "sshd", false},
	} {
		if fnmatch(c.name, c.pat) != c.ok {
			t.Errorf("fnmatch(%q, %q) != %v", c.name, c.pat, c.ok)
		}
	}
}

func TestStatusPort(t *testing.T) {
	for in, want := range map[string]int{
		`{"port": 443}`: 443,
		`{"proxy": {"port": 0}, "net": [{}, {"proxy_port": " 8443 "}], "PROXY_PORT": 9}`: 8443,
		`{"port": 0, "a": {"port": 1}, "PROXY_PORT": "7"}`:                               7,
		`{"port": 443.9}`:     443,
		`{"port": "x443"}`:    0,
		`{"port": [1]}`:       0,
		`{"port": 1} trash`:   0,
		`[{"proxy_port": 5}]`: 5,
	} {
		got, ok := statusPort(in)
		if (want == 0) == ok || got != want {
			t.Errorf("%s: %d %v", in, got, ok)
		}
	}
}

// stateDB - база 3x-ui и state.json под корнем t.TempDir().
func stateDB(t *testing.T) (root string, db *sql.DB) {
	root = t.TempDir()
	old := hostfs.Root
	hostfs.Root = root
	t.Cleanup(func() { hostfs.Root = old })
	path := services.XuiNativeDB()
	must(t, os.MkdirAll(filepath.Dir(path), 0o755))
	must(t, os.MkdirAll(filepath.Join(root, "var/lib/vps-portsync"), 0o755))
	makeDB(t, path, "create table settings (key text, value text);\ninsert into settings values ('webListen', '127.0.0.1');\n"+
		"create table inbounds (remark text, enable integer, listen text, port integer, protocol text, stream_settings text, up integer);\n"+
		"insert into inbounds values ('a', 1, '', 443, 'vless', '{}', 0);\n")
	db, err := sql.Open("sqlite", path)
	must(t, err)
	t.Cleanup(func() { db.Close() })
	return root, db
}

func writeState(t *testing.T, root, fp string, at time.Time) {
	b, _ := json.Marshal(map[string]any{"ufw_rules": []any{}, "xui_fp": fp, "full_at": float64(at.UnixNano()) / 1e9})
	must(t, os.WriteFile(filepath.Join(root, "var/lib/vps-portsync/state.json"), b, 0o644))
}

func TestXuiChanged(t *testing.T) {
	ctx := context.Background()
	root, db := stateDB(t)
	now := time.Now()
	if !XuiChanged(ctx, now) {
		t.Fatal("без state.json нужен полный проход")
	}
	x, err := services.ReadXuiWith(ctx, services.XuiNativeDB)
	must(t, err)
	writeState(t, root, x.Fingerprint, now.Add(-10*time.Second))
	if XuiChanged(ctx, now) {
		t.Fatal("ничего не менялось, полный проход недавно")
	}
	// счётчики трафика не в отпечатке
	if _, err := db.Exec("update inbounds set up = up + 100"); err != nil {
		t.Fatal(err)
	}
	if XuiChanged(ctx, now) {
		t.Fatal("счётчики трафика - не изменение")
	}
	if !XuiChanged(ctx, now.Add(FullEvery)) {
		t.Fatal("полный проход давно - нужен новый")
	}
	if !XuiChanged(ctx, now.Add(-time.Minute)) {
		t.Fatal("full_at в будущем - нужен полный проход")
	}
	if _, err := db.Exec("update inbounds set enable = 0"); err != nil {
		t.Fatal(err)
	}
	if !XuiChanged(ctx, now) {
		t.Fatal("inbound выключен - нужен полный проход")
	}
	writeState(t, root, "", now)
	if !XuiChanged(ctx, now) {
		t.Fatal("отпечатка в state.json нет - нужен полный проход")
	}
}

// База 3x-ui есть, но не читается - состояния нет, а не порты без 3x-ui.
func TestComputeFailsOnBrokenXui(t *testing.T) {
	root := t.TempDir()
	old := hostfs.Root
	hostfs.Root = root
	defer func() { hostfs.Root = old }()
	t.Setenv("PATH", root)
	must(t, os.MkdirAll(filepath.Join(root, "etc/x-ui"), 0o755))
	must(t, os.WriteFile(services.XuiNativeDB(), []byte("это не база sqlite, а мусор длиной больше заголовка sqlite..."), 0o644))
	if _, err := Compute(context.Background(), DefaultConfig()); err == nil {
		t.Fatal("ждали ошибку")
	}
	makeDB(t, filepath.Join(root, "etc/x-ui/new.db"), "create table settings (key text, value text);\n")
	must(t, os.Rename(filepath.Join(root, "etc/x-ui/new.db"), services.XuiNativeDB()))
	if _, err := Compute(context.Background(), DefaultConfig()); err == nil || !strings.Contains(err.Error(), "inbound") {
		t.Fatalf("нет таблицы inbounds - ждали ошибку, получили %v", err)
	}
	cfg := DefaultConfig()
	cfg.ExtraAllow = []string{"abc"}
	if _, err := Compute(context.Background(), cfg); err == nil {
		t.Fatal("мусор в extra_allow - ждали ошибку")
	}
}

// Нет состояния от агента - vps-portsync выходит с ошибкой и ничего не трогает.
func TestScriptKeepsRulesWithoutState(t *testing.T) {
	if pyPath == "" {
		t.Skip("нет python3")
	}
	s := newStand(t, "full")
	state := s.goState(t)
	before, _ := os.ReadFile(filepath.Join(s.root, "var/lib/vps-portsync/state.json"))
	var bad map[string]any
	must(t, json.Unmarshal(state, &bad))
	bad["host_allow"] = []any{[]any{"tcp", "443"}}
	badPort, _ := json.Marshal(bad)
	delete(bad, "host_allow")
	noAllow, _ := json.Marshal(bad)
	for i, c := range []struct {
		out string
		rc  int
	}{
		{string(state), 1}, {"", 0}, {"мусор", 0}, {"[]", 0}, {string(state)[:len(state)/2], 0},
		{string(badPort), 0}, {string(noAllow), 0}, {`{"ssh_port": 22}`, 0},
	} {
		s.agentStub(t, []byte(c.out), c.rc)
		_, errOut, rc := s.python(t, script, nil, "--verbose")
		if rc != 1 || !strings.Contains(errOut, "правила не менялись") {
			t.Errorf("случай %d: код %d, %s", i, rc, errOut)
		}
	}
	// агента нет совсем
	must(t, os.Remove(filepath.Join(s.root, "usr/local/bin/vps-agent")))
	if _, _, rc := s.python(t, script, nil); rc != 1 {
		t.Errorf("без агента: код %d", rc)
	}
	if b, err := os.ReadFile(s.log); err == nil && len(b) > 0 {
		t.Errorf("без состояния вызваны команды:\n%s", b)
	}
	after, _ := os.ReadFile(filepath.Join(s.root, "var/lib/vps-portsync/state.json"))
	if string(after) != string(before) {
		t.Error("без состояния изменён state.json")
	}
	if _, err := os.Stat(filepath.Join(s.root, "var/lib/vps-portsync/last.json")); err == nil {
		t.Error("без состояния записан last.json")
	}
}

// Запуск прямо от vps-portsync-xui.path (юнит прошлой версии): без изменений 3x-ui - выход.
func TestScriptTriggerUnit(t *testing.T) {
	if pyPath == "" {
		t.Skip("нет python3")
	}
	s := newStand(t, "full")
	state := s.goState(t)
	s.agentStub(t, state, 0)
	var st struct {
		XuiFP string `json:"xui_fp"`
	}
	must(t, json.Unmarshal(state, &st))
	writeState(t, s.root, st.XuiFP, time.Now())
	env := []string{"TRIGGER_UNIT=vps-portsync-xui.path"}
	if _, errOut, rc := s.python(t, script, env); rc != 0 {
		t.Fatalf("код %d: %s", rc, errOut)
	}
	if b, _ := os.ReadFile(s.log); len(b) > 0 {
		t.Fatalf("без изменений 3x-ui вызваны команды:\n%s", b)
	}
	writeState(t, s.root, st.XuiFP, time.Now().Add(-3*time.Minute))
	if _, errOut, rc := s.python(t, script, env); rc != 0 {
		t.Fatalf("код %d: %s", rc, errOut)
	}
	if b, _ := os.ReadFile(s.log); !strings.Contains(string(b), "ufw") {
		t.Fatal("полный проход давно - ждали применение")
	}
	b, _ := os.ReadFile(filepath.Join(s.root, "var/lib/vps-portsync/state.json"))
	if !strings.Contains(string(b), fmt.Sprintf("%q", st.XuiFP)) {
		t.Fatal("в state.json нет отпечатка 3x-ui от агента")
	}
}
