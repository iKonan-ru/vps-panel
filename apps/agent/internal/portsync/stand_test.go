package portsync

// Стенд port-sync: заглушки команд (ss, sshd, wg, awg, ip, mtproxyl, psql, docker, ufw, iptables,
// systemctl) в PATH, файлы сервера под подменённым корнем, docker - сокетом. На каждом наборе
// testdata/stand/<набор> агент считает желаемое состояние, vps-portsync.py применяет его с --plan
// и по-настоящему (вызовы ufw и iptables пишутся в журнал), результат сверяется с want-*.
// PORTSYNC_LEGACY=<путь к прежнему vps-portsync.py, который считал состояние сам> - ещё и сверка
// с ним на тех же наборах. -update переписывает want-*.

import (
	"context"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"unicode"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
)

var update = flag.Bool("update", false, "переписать want-* стенда port-sync")

const script = "../baseline/assets/vps-portsync.py"

type standCase struct {
	XuiDB       string `json:"xui_db"`
	Psql        bool   `json:"psql"`
	DockerUser  bool   `json:"docker_user"`
	Chain       bool   `json:"chain"`
	Jump        bool   `json:"jump"`
	NoComment   bool   `json:"no_comment"`
	LegacyKnown bool   `json:"legacy_known_processes"`
}

// stand - один развёрнутый набор: корень, заглушки, журнал вызовов.
type stand struct {
	src, dir, root, bin, log string
	c                        standCase
	py, cat                  string
}

// пути к cat и python3 - до того, как стенд заменит PATH
var catPath, pyPath = func() (string, string) {
	c, _ := exec.LookPath("cat")
	p, _ := exec.LookPath("python3")
	return c, p
}()

func newStand(t *testing.T, name string) *stand {
	t.Helper()
	cat, py := catPath, pyPath
	if cat == "" {
		t.Skip("нет cat")
	}
	dir := t.TempDir()
	s := &stand{src: filepath.Join("testdata/stand", name), dir: dir, root: filepath.Join(dir, "root"),
		bin: filepath.Join(dir, "bin"), log: filepath.Join(dir, "calls.log"), py: py, cat: cat}
	if b, err := os.ReadFile(filepath.Join(s.src, "case.json")); err == nil {
		if err := json.Unmarshal(b, &s.c); err != nil {
			t.Fatal(err)
		}
	}
	for _, d := range []string{s.root, s.bin, filepath.Join(s.root, "run"), filepath.Join(s.root, "var/lib/vps-portsync"),
		filepath.Join(s.root, "etc/ufw"), filepath.Join(s.root, "usr/local/bin"), filepath.Join(dir, "cmd")} {
		must(t, os.MkdirAll(d, 0o755))
	}
	s.copyTree(t, filepath.Join(s.src, "root"), s.root)
	s.copyTree(t, filepath.Join(s.src, "cmd"), filepath.Join(dir, "cmd"))
	if sqlText, err := os.ReadFile(filepath.Join(s.src, "xui.sql")); err == nil {
		db := filepath.Join(dir, "xui.db")
		if s.c.XuiDB != "" {
			db = filepath.Join(s.root, s.c.XuiDB)
		}
		makeDB(t, db, string(sqlText))
		if s.c.Psql {
			s.psqlOutputs(t, db)
		}
	}
	s.stubs(t)
	return s
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// copyTree копирует набор, подставляя корень вместо @ROOT@.
func (s *stand) copyTree(t *testing.T, from, to string) {
	t.Helper()
	_ = filepath.WalkDir(from, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		rel, _ := filepath.Rel(from, p)
		dst := filepath.Join(to, rel)
		if d.IsDir() {
			must(t, os.MkdirAll(dst, 0o755))
			return nil
		}
		b, err := os.ReadFile(p)
		must(t, err)
		must(t, os.WriteFile(dst, []byte(strings.ReplaceAll(string(b), "@ROOT@", s.root)), 0o644))
		return nil
	})
}

func makeDB(t *testing.T, path, text string) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Dir(path), 0o755))
	db, err := sql.Open("sqlite", path)
	must(t, err)
	defer db.Close()
	for _, stmt := range strings.Split(text, ";\n") {
		if strings.TrimSpace(stmt) != "" {
			if _, err := db.Exec(stmt); err != nil {
				t.Fatalf("%s: %v", stmt, err)
			}
		}
	}
}

// psqlOutputs - ответы psql -At -F \x1f -R \x1e на запросы port-sync, из той же базы sqlite.
func (s *stand) psqlOutputs(t *testing.T, path string) {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	must(t, err)
	defer db.Close()
	query := func(q string, enableCol int) string {
		rows, err := db.Query(q)
		must(t, err)
		defer rows.Close()
		cols, _ := rows.Columns()
		var recs []string
		for rows.Next() {
			vals := make([]sql.NullString, len(cols))
			ptrs := make([]any, len(cols))
			for i := range vals {
				ptrs[i] = &vals[i]
			}
			must(t, rows.Scan(ptrs...))
			var f []string
			for i, v := range vals {
				if i == enableCol {
					v.String = map[string]string{"1": "t", "0": "f"}[v.String]
				}
				f = append(f, v.String)
			}
			recs = append(recs, strings.Join(f, "\x1f"))
		}
		return strings.Join(recs, "\x1e") + "\n"
	}
	var n int
	must(t, db.QueryRow("select count(*) from pragma_table_info('inbounds') where name='node_id'").Scan(&n))
	node := "0"
	if n > 0 {
		node = "coalesce(node_id,0)"
	}
	cmd := filepath.Join(s.dir, "cmd")
	must(t, os.WriteFile(filepath.Join(cmd, "psql-settings.out"), []byte(query("select key, value from settings", -1)), 0o644))
	must(t, os.WriteFile(filepath.Join(cmd, "psql-node.out"), []byte(fmt.Sprintf("%d\n", n)), 0o644))
	must(t, os.WriteFile(filepath.Join(cmd, "psql-inbounds.out"), []byte(query("select port, protocol, coalesce(listen,''), enable, coalesce(stream_settings,''), coalesce(remark,''), "+node+" from inbounds", 3)), 0o644))
}

type dockerItem struct {
	ID    string `json:"Id"`
	State struct {
		Running bool `json:"Running"`
	} `json:"State"`
	raw json.RawMessage
}

func (s *stand) containers(t *testing.T) []dockerItem {
	b, err := os.ReadFile(filepath.Join(s.dir, "cmd/docker.json"))
	if err != nil {
		return nil
	}
	var raws []json.RawMessage
	must(t, json.Unmarshal(b, &raws))
	var out []dockerItem
	for _, r := range raws {
		var it dockerItem
		must(t, json.Unmarshal(r, &it))
		it.raw = r
		out = append(out, it)
	}
	return out
}

// stubs пишет заглушки команд: есть файл набора - есть команда.
func (s *stand) stubs(t *testing.T) {
	t.Helper()
	cmd := filepath.Join(s.dir, "cmd")
	write := func(name, body string) {
		must(t, os.WriteFile(filepath.Join(s.bin, name), []byte("#!/bin/sh\n"+body+"\n"), 0o755))
	}
	logArgs := fmt.Sprintf(`{ printf '%%s' "${0##*/}"; for a in "$@"; do printf ' [%%s]' "$a"; done; echo; } >> %s`, s.log)
	for name, file := range map[string]string{"ss": "ss.txt", "sshd": "sshd.txt", "wg": "wg.txt", "awg": "awg.txt", "ip": "ip.txt", "mtproxyl": "mtproxyl.json"} {
		if _, err := os.Stat(filepath.Join(cmd, file)); err == nil {
			write(name, fmt.Sprintf("exec %s %s", s.cat, filepath.Join(cmd, file)))
		}
	}
	if s.c.Psql {
		write("psql", fmt.Sprintf(`case "$*" in
*"from settings"*) exec %[1]s %[2]s/psql-settings.out ;;
*information_schema*) exec %[1]s %[2]s/psql-node.out ;;
*"from inbounds"*) exec %[1]s %[2]s/psql-inbounds.out ;;
esac
exit 1`, s.cat, cmd))
	}
	if items := s.containers(t); items != nil {
		var ids []string
		var running []json.RawMessage
		for _, it := range items {
			if it.State.Running {
				ids = append(ids, it.ID)
				running = append(running, it.raw)
			}
		}
		b, _ := json.Marshal(running)
		must(t, os.WriteFile(filepath.Join(cmd, "docker-ps.txt"), []byte(strings.Join(ids, "\n")+"\n"), 0o644))
		must(t, os.WriteFile(filepath.Join(cmd, "docker-inspect.json"), b, 0o644))
		write("docker", fmt.Sprintf(`case "$1" in
ps) exec %[1]s %[2]s/docker-ps.txt ;;
inspect) exec %[1]s %[2]s/docker-inspect.json ;;
esac
exit 1`, s.cat, cmd))
	}
	flagFile := func(on bool, name string) string {
		p := filepath.Join(s.dir, name)
		if on {
			must(t, os.WriteFile(p, nil, 0o644))
		}
		return p
	}
	du, jump, nc := flagFile(s.c.DockerUser, "docker-user"), flagFile(s.c.Jump, "jump"), flagFile(s.c.NoComment, "no-comment")
	chain := filepath.Join(cmd, "chain.txt")
	if !s.c.Chain {
		chain = filepath.Join(s.dir, "no-chain")
	}
	write("iptables", logArgs+fmt.Sprintf(`
case "$*" in
*"-nL DOCKER-USER"*) [ -e %s ] ;;
*"-S VPS-PORTSYNC"*) [ -e %[2]s ] && exec %[5]s %[2]s ;;
*"-C DOCKER-USER"*) [ -e %[3]s ] ;;
*"--comment"*) [ ! -e %[4]s ] ;;
*) true ;;
esac`, du, chain, jump, nc, s.cat))
	write("ufw", logArgs)
	write("systemctl", logArgs)
}

// dockerSocket - Docker Engine API на сокете под корнем: только чтение списка и inspect.
func (s *stand) dockerSocket(t *testing.T) {
	items := s.containers(t)
	if items == nil {
		return
	}
	sock := filepath.Join(s.root, "var/run/docker.sock")
	must(t, os.MkdirAll(filepath.Dir(sock), 0o755))
	ln, err := net.Listen("unix", sock)
	must(t, err)
	srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/containers/json" {
			list := []map[string]string{}
			for _, it := range items {
				if it.State.Running || r.URL.Query().Get("all") == "1" {
					list = append(list, map[string]string{"Id": it.ID})
				}
			}
			_ = json.NewEncoder(w).Encode(list)
			return
		}
		for _, it := range items {
			if r.URL.Path == "/containers/"+it.ID+"/json" {
				_, _ = w.Write([]byte(strings.ReplaceAll(string(it.raw), "@ROOT@", s.root)))
				return
			}
		}
		http.NotFound(w, r)
	})}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
}

// goState - состояние, которое посчитал агент на этом стенде (JSON, как печатает -portsync-state).
func (s *stand) goState(t *testing.T) []byte {
	t.Helper()
	s.dockerSocket(t)
	s.use(t)
	cfg, err := ReadConfig()
	must(t, err)
	st, err := Compute(context.Background(), cfg)
	must(t, err)
	b, err := json.MarshalIndent(st, "", "  ")
	must(t, err)
	return b
}

// use - корень и PATH стенда до конца теста.
func (s *stand) use(t *testing.T) {
	old := hostfs.Root
	hostfs.Root = s.root
	t.Cleanup(func() { hostfs.Root = old })
	t.Setenv("PATH", s.bin)
}

// python запускает скрипт с подменённым корнем; os.geteuid - 0, чтобы стенд работал и не под root.
func (s *stand) python(t *testing.T, path string, env []string, args ...string) (string, string, int) {
	t.Helper()
	argv, _ := json.Marshal(append([]string{path}, args...))
	code := fmt.Sprintf("import os, sys, runpy; os.geteuid = lambda: 0; sys.argv = %s; runpy.run_path(sys.argv[0], run_name='__main__')", argv)
	cmd := exec.Command(s.py, "-c", code)
	cmd.Env = append([]string{"PATH=" + s.bin, "PORTSYNC_TEST_ROOT=" + s.root, "PYTHONIOENCODING=utf-8", "PYTHONDONTWRITEBYTECODE=1"}, env...)
	var out, errb strings.Builder
	cmd.Stdout, cmd.Stderr = &out, &errb
	err := cmd.Run()
	rc := 0
	if ee, ok := err.(*exec.ExitError); ok {
		rc = ee.ExitCode()
	} else if err != nil {
		t.Fatal(err)
	}
	return s.norm(out.String()), s.norm(errb.String()), rc
}

// agentStub - vps-agent на стенде печатает заданное состояние.
func (s *stand) agentStub(t *testing.T, state []byte, rc int) {
	p := filepath.Join(s.dir, "agent-state.json")
	must(t, os.WriteFile(p, state, 0o644))
	body := fmt.Sprintf("[ \"$1\" = -portsync-state ] || exit 3\n%s %s\nexit %d", s.cat, p, rc)
	must(t, os.WriteFile(filepath.Join(s.root, "usr/local/bin/vps-agent"), []byte("#!/bin/sh\n"+body+"\n"), 0o755))
}

func (s *stand) norm(v string) string { return strings.ReplaceAll(v, s.root, "@ROOT@") }

// applied - журнал вызовов и итог state.json после запуска (без отпечатка и времени).
func (s *stand) applied(t *testing.T) string {
	calls, _ := os.ReadFile(s.log)
	var st map[string]any
	b, _ := os.ReadFile(filepath.Join(s.root, "var/lib/vps-portsync/state.json"))
	_ = json.Unmarshal(b, &st)
	delete(st, "xui_fp")
	delete(st, "full_at")
	sb, _ := json.MarshalIndent(st, "", "  ")
	return s.norm(string(calls)) + "--- state.json\n" + s.norm(string(sb)) + "\n"
}

// legacy - прежний скрипт с путями под корнем стенда.
func (s *stand) legacy(t *testing.T, src string) string {
	b, err := os.ReadFile(src)
	must(t, err)
	text := regexp.MustCompile(`(["'])/(etc|run|var|opt|lib|usr)/`).ReplaceAllString(string(b), "${1}"+s.root+"/${2}/")
	// путь внутри контейнера, а не на сервере
	text = strings.ReplaceAll(text, `== "`+s.root+`/etc/x-ui"`, `== "/etc/x-ui"`)
	p := filepath.Join(s.dir, "legacy-vps-portsync.py")
	must(t, os.WriteFile(p, []byte(text), 0o644))
	return p
}

// escapeJSON - не клавиатурные символы (кроме кириллицы) в want-* - как \uXXXX.
func escapeJSON(b []byte) []byte {
	var sb strings.Builder
	for _, r := range string(b) {
		if r < 0x80 || unicode.Is(unicode.Cyrillic, r) {
			sb.WriteRune(r)
		} else if r > 0xffff {
			r -= 0x10000
			fmt.Fprintf(&sb, `\u%04x\u%04x`, 0xd800+(r>>10), 0xdc00+(r&0x3ff))
		} else {
			fmt.Fprintf(&sb, `\u%04x`, r)
		}
	}
	return []byte(sb.String())
}

func golden(t *testing.T, path, got string) {
	t.Helper()
	if *update {
		must(t, os.WriteFile(path, []byte(got), 0o644))
		return
	}
	want, err := os.ReadFile(path)
	must(t, err)
	if string(want) != got {
		t.Errorf("%s не совпал:\n--- ждали\n%s\n--- получили\n%s", path, want, got)
	}
}

func jsonEqual(t *testing.T, what string, a, b []byte, skip ...string) {
	t.Helper()
	var x, y map[string]any
	must(t, json.Unmarshal(a, &x))
	must(t, json.Unmarshal(b, &y))
	for _, k := range skip {
		delete(x, k)
		delete(y, k)
	}
	for k := range x {
		if !reflect.DeepEqual(x[k], y[k]) {
			t.Errorf("%s: %s расходится:\n  агент:  %v\n  прежний: %v", what, k, x[k], y[k])
		}
	}
	for k := range y {
		if _, ok := x[k]; !ok {
			t.Errorf("%s: %s нет у агента", what, k)
		}
	}
}

func TestStand(t *testing.T) {
	entries, err := os.ReadDir("testdata/stand")
	must(t, err)
	legacySrc := os.Getenv("PORTSYNC_LEGACY")
	for _, e := range entries {
		name := e.Name()
		t.Run(name, func(t *testing.T) {
			s := newStand(t, name)
			state := s.goState(t)
			golden(t, filepath.Join(s.src, "want-state.json"), string(escapeJSON([]byte(s.norm(string(state)))))+"\n")
			if s.py == "" {
				t.Skip("нет python3: скрипт не проверен")
			}
			s.agentStub(t, state, 0)
			plan, errOut, rc := s.python(t, script, nil, "--plan")
			if rc != 0 {
				t.Fatalf("--plan: код %d: %s", rc, errOut)
			}
			golden(t, filepath.Join(s.src, "want-plan.txt"), plan)
			js, _, rc := s.python(t, script, nil, "--json")
			if rc != 0 {
				t.Fatalf("--json: код %d", rc)
			}
			jsonEqual(t, "--json", []byte(s.norm(string(state))), []byte(js))
			out, errOut, rc := s.python(t, script, nil, "--verbose")
			if rc != 0 {
				t.Fatalf("применение: код %d: %s", rc, errOut)
			}
			golden(t, filepath.Join(s.src, "want-apply.txt"), out+"--- calls\n"+s.applied(t))
			last, err := os.ReadFile(filepath.Join(s.root, "var/lib/vps-portsync/last.json"))
			must(t, err)
			jsonEqual(t, "last.json", state, last)

			if legacySrc == "" {
				return
			}
			// прежний скрипт на таком же стенде
			l := newStand(t, name)
			l.dockerSocket(t)
			var env []string
			if l.c.LegacyKnown {
				// без конфига прежний скрипт брал known_processes ["sshd"], агент - список по
				// умолчанию (решено так); остальное без конфига у обоих одинаково
				cfg, _ := json.Marshal(map[string]any{"known_processes": DefaultConfig().KnownProcesses})
				env = append(env, "PORTSYNC_CONF="+string(cfg))
			}
			lp := l.legacy(t, legacySrc)
			ljs, lerr, rc := l.python(t, lp, env, "--json")
			if rc != 0 {
				t.Fatalf("прежний --json: код %d: %s", rc, lerr)
			}
			jsonEqual(t, "прежний --json", []byte(s.norm(string(state))), []byte(ljs), "xui_fp")
			lplan, _, _ := l.python(t, lp, env, "--plan")
			if lplan != plan {
				t.Errorf("--plan расходится с прежним:\n--- агент\n%s\n--- прежний\n%s", plan, lplan)
			}
			lout, lerr, rc := l.python(t, lp, env, "--verbose")
			if rc != 0 {
				t.Fatalf("прежний: код %d: %s", rc, lerr)
			}
			if got, want := out+"--- calls\n"+s.applied(t), lout+"--- calls\n"+l.applied(t); got != want {
				t.Errorf("применение расходится с прежним:\n--- агент\n%s\n--- прежний\n%s", got, want)
			}
		})
	}
}
