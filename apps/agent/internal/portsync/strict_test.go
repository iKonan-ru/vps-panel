package portsync

import (
	"context"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
)

// Нет полных данных - нет состояния: ни один порт не закрывается из-за того, что о нём не узнали.

func computeStand(t *testing.T, s *stand, ctx context.Context) (*State, error) {
	t.Helper()
	s.use(t)
	cfg, err := ReadConfig()
	must(t, err)
	return Compute(ctx, cfg)
}

func TestComputeExpiredDeadline(t *testing.T) {
	s := newStand(t, "full")
	s.dockerSocket(t)
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(-time.Second))
	defer cancel()
	if st, err := computeStand(t, s, ctx); err == nil {
		t.Fatalf("истёкший дедлайн - ждали ошибку, получили %v", st.HostAllow)
	}
	// дедлайн истекает на последнем шаге (ip route): его вывод пропал, состояния нет
	s = newStand(t, "full")
	s.dockerSocket(t)
	must(t, os.WriteFile(filepath.Join(s.bin, "ip"), []byte("#!/bin/sh\nexec sleep 5\n"), 0o755))
	must(t, os.Symlink(sleepPath, filepath.Join(s.bin, "sleep")))
	ctx, cancel = context.WithTimeout(context.Background(), 1500*time.Millisecond)
	defer cancel()
	if st, err := computeStand(t, s, ctx); err == nil {
		t.Fatalf("дедлайн истёк по ходу - ждали ошибку, получили %v", st.HostAllow)
	}
}

var sleepPath, _ = exec.LookPath("sleep")

func TestComputeFailingCommands(t *testing.T) {
	for name, body := range map[string]string{
		"ss":       "exit 1",
		"wg":       "", // не запускается: битый интерпретатор
		"mtproxyl": "",
	} {
		t.Run(name, func(t *testing.T) {
			s := newStand(t, "full")
			if name == "mtproxyl" {
				// порт MTProxyL - из status --json, а не из config.toml
				must(t, os.Remove(filepath.Join(s.root, "opt/mtproxyl/mtproxy/config.toml")))
			}
			s.dockerSocket(t)
			script := "#!/bin/sh\n" + body + "\n"
			if body == "" {
				script = "#!/nonexistent/sh\n"
			}
			must(t, os.WriteFile(filepath.Join(s.bin, name), []byte(script), 0o755))
			if _, err := computeStand(t, s, context.Background()); err == nil {
				t.Fatalf("%s не отработал - ждали ошибку", name)
			}
		})
	}
	// wg вышел с ошибкой (нет модуля ядра) - интерфейсов нет, это не ошибка
	s := newStand(t, "full")
	s.dockerSocket(t)
	must(t, os.WriteFile(filepath.Join(s.bin, "wg"), []byte("#!/bin/sh\nexit 1\n"), 0o755))
	st, err := computeStand(t, s, context.Background())
	must(t, err)
	if st.Allowed()["51830/udp"] {
		t.Fatal("порт wg0 открыт, хотя wg вышел с ошибкой")
	}
}

func TestComputeDockerNotAnswering(t *testing.T) {
	s := newStand(t, "full")
	// сокет есть, docker не слушает
	sock := filepath.Join(s.root, "var/run/docker.sock")
	must(t, os.MkdirAll(filepath.Dir(sock), 0o755))
	ln, err := net.ListenUnix("unix", &net.UnixAddr{Name: sock, Net: "unix"})
	must(t, err)
	ln.SetUnlinkOnClose(false)
	must(t, ln.Close())
	if _, err := computeStand(t, s, context.Background()); err == nil || !strings.Contains(err.Error(), "docker") {
		t.Fatalf("docker не ответил - ждали ошибку, получили %v", err)
	}
}

func TestComputeDockerInspect(t *testing.T) {
	for status, fails := range map[int]bool{http.StatusNotFound: false, http.StatusInternalServerError: true} {
		s := newStand(t, "empty")
		sock := filepath.Join(s.root, "var/run/docker.sock")
		must(t, os.MkdirAll(filepath.Dir(sock), 0o755))
		ln, err := net.Listen("unix", sock)
		must(t, err)
		srv := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == "/containers/json" {
				_, _ = w.Write([]byte(`[{"Id": "gone"}]`))
				return
			}
			http.Error(w, `{"message": "x"}`, status)
		})}
		go func() { _ = srv.Serve(ln) }()
		_, err = computeStand(t, s, context.Background())
		_ = srv.Close()
		if (err != nil) != fails {
			t.Errorf("inspect %d: ошибка %v", status, err)
		}
	}
}

func writeConf(t *testing.T, root, text string) {
	t.Helper()
	must(t, os.MkdirAll(filepath.Join(root, "etc"), 0o755))
	must(t, os.WriteFile(filepath.Join(root, ConfPath), []byte(text), 0o644))
}

func TestReadConfig(t *testing.T) {
	root := t.TempDir()
	old := hostfs.Root
	hostfs.Root = root
	defer func() { hostfs.Root = old }()

	cfg, err := ReadConfig()
	must(t, err)
	if len(cfg.DenyPublicPorts) != 0 || cfg.DenyPublicPorts == nil || len(cfg.KnownProcesses) == 0 {
		t.Fatalf("без конфига: deny пустой, known_processes по умолчанию: %+v", cfg)
	}
	writeConf(t, root, `{"extra_allow": ["443/tcp", 51820,], "admin_ips": ["1.2.3.4"]}`)
	if _, err := ReadConfig(); err == nil {
		t.Fatal("лишняя запятая - ждали ошибку, а не настройки по умолчанию")
	}
	writeConf(t, root, `{"extra_allow": ["443/tcp", 51820], "deny_public_ports": [9090]}`)
	cfg, err = ReadConfig()
	must(t, err)
	if strings.Join(cfg.ExtraAllow, ",") != "443/tcp,51820" || strings.Join(cfg.DenyPublicPorts, ",") != "9090" {
		t.Fatalf("числа в списках портов: %+v", cfg)
	}
	for _, bad := range []string{`{"extra_allow": [51820.5]}`, `{"extra_allow": [true]}`, `{"known_processes": [1]}`, `[]`} {
		writeConf(t, root, bad)
		if _, err := ReadConfig(); err == nil {
			t.Errorf("%s - ждали ошибку", bad)
		}
	}
}

// Порт вне 1-65535 или не tcp/udp отбрасывается с замечанием, остальное применяется.
func TestComputeDropsInvalidPorts(t *testing.T) {
	s := newStand(t, "empty")
	must(t, os.MkdirAll(filepath.Join(s.root, "opt/mtproxyl/mtproxy"), 0o755))
	must(t, os.WriteFile(filepath.Join(s.root, "opt/mtproxyl/mtproxy/config.toml"), []byte("port = 70000\n"), 0o644))
	must(t, os.WriteFile(filepath.Join(s.bin, "awg"), []byte("#!/bin/sh\necho 'awg0 0'\necho 'awg1 51821'\n"), 0o755))
	s.use(t)
	cfg, err := ReadConfig()
	must(t, err)
	cfg.DenyPublicPorts = nil
	cfg.ExtraAllow = []string{"5555/sctp", "6666/udp"}
	st, err := Compute(context.Background(), cfg)
	must(t, err)
	got := st.Allowed()
	for _, k := range []string{"22/tcp", "6666/udp", "51821/udp"} {
		if !got[k] {
			t.Errorf("нет %s: %v", k, st.HostAllow)
		}
	}
	for _, k := range []string{"70000/tcp", "5555/sctp", "0/udp"} {
		if got[k] {
			t.Errorf("%s не должен открываться", k)
		}
	}
	var dropped []string
	for _, f := range st.Findings {
		if f[0] == "medium" && strings.Contains(f[1], "пропущен") {
			dropped = append(dropped, f[1])
		}
	}
	// 70000/tcp MTProxyL, 0/udp awg0 и 5555/sctp - на хосте и для контейнеров
	if len(dropped) != 4 || !strings.Contains(strings.Join(dropped, ";"), "70000/tcp (MTProxyL)") {
		t.Fatalf("замечания: %q", dropped)
	}
	if _, err := Compute(context.Background(), Config{ExtraAllow: []string{"x/sctp"}}); err == nil {
		t.Fatal("не число в extra_allow - ждали ошибку")
	}
}

// Полный проход по записи 3x-ui не удаётся - тот же отпечаток запускает его снова не чаще FullEvery.
func TestStartFullRepeat(t *testing.T) {
	ctx := context.Background()
	root, db := stateDB(t)
	now := time.Now()
	if !StartFull(ctx, now) {
		t.Fatal("первый запуск нужен")
	}
	if StartFull(ctx, now.Add(5*time.Second)) {
		t.Fatal("проход не удался (state.json нет), тот же отпечаток - повтор только через FullEvery")
	}
	if !StartFull(ctx, now.Add(FullEvery+time.Second)) {
		t.Fatal("через FullEvery - повтор")
	}
	if _, err := db.Exec("update inbounds set port = 8443"); err != nil {
		t.Fatal(err)
	}
	if !StartFull(ctx, now.Add(FullEvery+2*time.Second)) {
		t.Fatal("новый отпечаток - запуск сразу")
	}
	// проход удался: state.json с этим отпечатком - запускать нечего
	x, err := services.ReadXuiWith(ctx, services.XuiNativeDB)
	must(t, err)
	writeState(t, root, x.Fingerprint, now.Add(FullEvery+3*time.Second))
	if StartFull(ctx, now.Add(FullEvery+10*time.Second)) {
		t.Fatal("ничего не менялось")
	}
}
