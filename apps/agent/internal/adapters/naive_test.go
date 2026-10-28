package adapters

import (
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func naiveTestConfig() NaiveConfig {
	return NaiveConfig{Domain: "hoster.example.com", Port: 8444, Mask443: true, Secret: "a1b2c3d4e5f6a7b8c9d0.test"}
}

func TestNaiveRenderUsers(t *testing.T) {
	text, err := NaiveRender(naiveTestConfig(), map[string]string{
		"petr-0f0f": "BBBBBBBBBBBBBBBBBBBBBBBB",
		"ivan-a1b2": "AAAAAAAAAAAAAAAAAAAAAAAA",
	}, []string{"203.0.113.7/32"})
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"https_port 8444",
		":8444, https://hoster.example.com:8444 {",
		"basic_auth ivan-a1b2 AAAAAAAAAAAAAAAAAAAAAAAA",
		"basic_auth petr-0f0f BBBBBBBBBBBBBBBBBBBBBBBB",
		"probe_resistance a1b2c3d4e5f6a7b8c9d0.test",
		"disable_http_challenge",
		"protocols h1 h2",
		"deny 127.0.0.0/8",
		"deny 10.0.0.0/8",
		"deny 203.0.113.7/32",
		"deny localhost *.localhost",
		"allow all",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("нет %q в\n%s", want, text)
		}
	}
	// запреты - до "allow all": правила acl проверяются по порядку
	if strings.Index(text, "deny 127.0.0.0/8") > strings.Index(text, "allow all") {
		t.Error("deny после allow all")
	}
	// имена по порядку: конфиг не меняется от порядка в map
	if strings.Index(text, "ivan-a1b2") > strings.Index(text, "petr-0f0f") {
		t.Error("пользователи не по порядку")
	}
	if strings.Contains(text, ":443") || strings.Contains(text, "http://") || !strings.Contains(text, "\n:8444, ") {
		t.Error("при маске MTProxyL и без 80 Caddy не должен слушать 443 и 80")
	}
}

// Без пользователей прокси нет совсем: forward_proxy без basic_auth - открытый прокси.
func TestNaiveRenderNoUsersNoProxy(t *testing.T) {
	text, err := NaiveRender(naiveTestConfig(), map[string]string{}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, "forward_proxy") {
		t.Fatalf("без пользователей forward_proxy в конфиге:\n%s", text)
	}
	if !strings.Contains(text, "file_server @page") || !strings.Contains(text, "rewrite @page /index.html") || !strings.Contains(text, "respond 405") {
		t.Fatal("нет заглушки")
	}
}

func TestNaiveRender443And80(t *testing.T) {
	c := naiveTestConfig()
	c.Mask443, c.Listen443, c.HTTP80 = false, true, true
	text, err := NaiveRender(c, nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{":8444, https://hoster.example.com:8444, https://:443, https://hoster.example.com:443 {", "http_port 80", "http://hoster.example.com {"} {
		if !strings.Contains(text, want) {
			t.Errorf("нет %q", want)
		}
	}
	if strings.Contains(text, "disable_http_challenge") {
		t.Error("с 80 HTTP-01 не выключается")
	}
}

// Сервер панели: сертификат файлами от Caddy панели, без выпуска, 443 и 80 не слушаем.
func TestNaiveRenderExternalCert(t *testing.T) {
	c := naiveTestConfig()
	c.Mask443, c.ExternalCert = false, true
	text, err := NaiveRender(c, map[string]string{"ivan-a1b2": "AAAAAAAAAAAAAAAAAAAAAAAA"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	crt, key := NaiveCertPaths(c.Domain)
	if !strings.Contains(text, "\ttls "+crt+" "+key+"\n") {
		t.Errorf("нет tls с файлами в\n%s", text)
	}
	if strings.Contains(text, "http_port") || strings.Contains(text, "cert_issuer") || strings.Contains(text, ":443") {
		t.Errorf("с сертификатом панели прокси не выпускает и не слушает 443/80:\n%s", text)
	}
	if !strings.Contains(text, "\tauto_https disable_redirects disable_certs\n") {
		t.Errorf("с сертификатом панели нужен auto_https disable_certs, иначе Caddy прокси занимает 80 для HTTP-01:\n%s", text)
	}
	if !strings.HasSuffix(crt, "/certificates/panel/hoster.example.com/hoster.example.com.crt") {
		t.Errorf("путь сертификата %s: NaiveCertExpiry ищет certificates/*/<имя>/<имя>.crt", crt)
	}
	c.HTTP80 = true
	if _, err := NaiveRender(c, nil, nil); err == nil {
		t.Error("сертификат панели и 80 вместе - ошибка")
	}
}

// Все раскладки 443 и 80 - настоящим Caddy (caddy adapt разбирает конфиг без запуска служб).
// Бинарник собирает tools/build-naive.sh; его нет - тест пропускается.
func TestNaiveRenderCaddyAdapts(t *testing.T) {
	bin, _ := filepath.Abs(filepath.Join("..", "..", "..", "..", "deploy", "files", "naive", "caddy-linux-"+runtime.GOARCH))
	if _, err := os.Stat(bin); err != nil || runtime.GOOS != "linux" {
		t.Skip("нет сборки Caddy: tools/build-naive.sh")
	}
	users := map[string]string{"ivan-a1b2": "AAAAAAAAAAAAAAAAAAAAAAAA"}
	for _, mode := range []struct{ listen, mask, http80, ext bool }{
		{false, false, false, false}, {false, false, true, false}, {true, false, false, false},
		{true, false, true, false}, {false, true, false, false}, {false, true, true, false},
		{false, false, false, true},
	} {
		c := naiveTestConfig()
		c.Listen443, c.Mask443, c.HTTP80, c.ExternalCert = mode.listen, mode.mask, mode.http80, mode.ext
		for _, u := range []map[string]string{nil, users} {
			text, err := NaiveRender(c, u, []string{"203.0.113.7/32"})
			if err != nil {
				t.Fatal(err)
			}
			f := filepath.Join(t.TempDir(), "Caddyfile")
			if err := os.WriteFile(f, []byte(text), 0o600); err != nil {
				t.Fatal(err)
			}
			out, err := exec.Command(bin, "adapt", "--config", f, "--adapter", "caddyfile").CombinedOutput()
			if err != nil {
				t.Errorf("%+v, пользователей %d: Caddy не принял конфиг: %s\n%s", mode, len(u), out, text)
			}
			// сертификат панели: Caddy прокси ничего не выпускает (иначе проверка HTTP-01 держит 80)
			if mode.ext && strings.Contains(string(out), `"automate"`) {
				t.Errorf("%+v: Caddy прокси выпускает сертификат сам:\n%s", mode, out)
			}
		}
	}
}

func TestNaiveRenderRejectsBadInput(t *testing.T) {
	bad := []struct {
		c     func(*NaiveConfig)
		users map[string]string
	}{
		{func(c *NaiveConfig) { c.Domain = "evil.ru\n}" }, nil},
		{func(c *NaiveConfig) { c.Port = 443 }, nil},
		{func(c *NaiveConfig) { c.Secret = c.Domain }, nil},
		{func(c *NaiveConfig) { c.Listen443 = true }, nil},
		{func(*NaiveConfig) {}, map[string]string{"ivan a": "AAAAAAAAAAAAAAAAAAAAAAAA"}},
		{func(*NaiveConfig) {}, map[string]string{"ivan": "short"}},
		{func(*NaiveConfig) {}, map[string]string{"ivan": "AAAAAAAAAAAAAAAA AAAAAAAA"}},
	}
	for i, b := range bad {
		c := naiveTestConfig()
		b.c(&c)
		if _, err := NaiveRender(c, b.users, nil); err == nil {
			t.Errorf("случай %d: ждали ошибку", i)
		}
	}
}

func TestNaiveRenderFiles(t *testing.T) {
	naiveDir = t.TempDir()
	if err := NaiveRenderFiles(); err == nil {
		t.Fatal("без config.json ждали ошибку")
	}
	cfg := `{"domain":"hoster.example.com","port":8444,"mask443":true,"secret":"a1b2c3d4e5f6a7b8c9d0.test"}`
	if err := os.WriteFile(filepath.Join(naiveDir, "config.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := NaiveRenderFiles(); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(filepath.Join(naiveDir, "Caddyfile"))
	if err != nil || !strings.Contains(string(b), "hoster.example.com:8444") || strings.Contains(string(b), "forward_proxy") {
		t.Fatalf("Caddyfile: %v\n%s", err, b)
	}
	if st, err := os.Stat(filepath.Join(naiveDir, "users.json")); err != nil || st.Mode().Perm() != 0o600 {
		t.Fatalf("users.json: %v", err)
	}
	// заглушка - файлом рядом, её путь - в Caddyfile
	stub, err := os.ReadFile(filepath.Join(naiveDir, "www", "index.html"))
	if err != nil || !strings.Contains(string(stub), "VPS <b>Panel</b>") {
		t.Fatalf("заглушка: %v", err)
	}
	if !strings.Contains(string(b), "root * "+filepath.Join(naiveDir, "www")) {
		t.Fatalf("в Caddyfile нет пути заглушки:\n%s", b)
	}
	if changed, err := naiveWriteStub(); err != nil || changed {
		t.Fatalf("та же заглушка - не изменение: %v %v", changed, err)
	}
}
