package adapters

import (
	"bytes"
	"context"
	"crypto/x509"
	_ "embed"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"net"
	"os"
	"os/user"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Прокси для браузера: Caddy с forwardproxy (naive), служба
// vps-naive. Настройки пишет команда установки в /etc/vps-naive/config.json, пользователей
// (клиентов панели) ведёт агент в users.json, Caddyfile агент собирает из них сам
// (NaiveRender): и при установке (vps-agent -naive-render), и при каждой правке пользователей.
// Без пользователей прокси в конфиге нет совсем - только сайт-заглушка: открытого прокси не
// бывает ни на одном шаге.

var (
	naiveDir  = "/etc/vps-naive"
	naiveUnit = "/etc/systemd/system/vps-naive.service"
	naiveBin  = "/opt/vps-naive/caddy"
	naiveData = "/var/lib/vps-naive"
)

const (
	naiveSock  = "/run/vps-naive/admin.sock"
	naiveGroup = "vps-naive"
)

// NaiveConfig - /etc/vps-naive/config.json (пишет команда установки).
type NaiveConfig struct {
	Domain    string `json:"domain"`
	Port      int    `json:"port"`
	Listen443 bool   `json:"listen443"` // Caddy слушает и 443 (443 был свободен)
	Mask443   bool   `json:"mask443"`   // 443 держит MTProxyL, наш SNI telemt передаёт на Port
	HTTP80    bool   `json:"http80"`    // 80 для выпуска HTTP-01 и как у обычного сайта
	Secret    string `json:"secret"`    // имя для probe_resistance: на него прокси отвечает 407
}

var (
	reNaiveHost = regexp.MustCompile(`^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$`)
	reNaiveUser = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,63}$`)
	reNaivePass = regexp.MustCompile(`^[A-Za-z0-9]{16,64}$`)
)

func (c NaiveConfig) check() error {
	if !reNaiveHost.MatchString(c.Domain) {
		return fmt.Errorf("имя прокси %q: нужен домен", c.Domain)
	}
	if c.Port < 1 || c.Port > 65535 || c.Port == 80 || c.Port == 443 {
		return fmt.Errorf("порт прокси %d: 1-65535, кроме 80 и 443", c.Port)
	}
	if !reNaiveHost.MatchString(c.Secret) || c.Secret == c.Domain {
		return errors.New("секретное имя: нужен домен, отличный от имени прокси")
	}
	if c.Listen443 && c.Mask443 {
		return errors.New("443: либо Caddy, либо маска MTProxyL")
	}
	return nil
}

// naiveStub - страница для всех, кто пришёл без пароля: прокси выглядит обычным сайтом (логотип
// и название панели, без текста). Агент кладёт её в <naiveDir>/www, Caddy отдаёт файлом: в
// строке Caddyfile фигурные скобки CSS Caddy принял бы за плейсхолдеры.
//
//go:embed naive_stub.html
var naiveStub []byte

// naivePrivateNets - куда прокси не пускает никого: loopback, частные и служебные сети.
var naivePrivateNets = []string{
	"127.0.0.0/8", "0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "169.254.0.0/16",
	"172.16.0.0/12", "192.168.0.0/16", "::1/128", "fc00::/7", "fe80::/10",
}

// NaiveRender - Caddyfile из настроек и пользователей (имя -> пароль). deny - адреса самого
// сервера (NaiveLocalIPs): к ним прокси тоже не пускает.
func NaiveRender(c NaiveConfig, users map[string]string, deny []string) (string, error) {
	if err := c.check(); err != nil {
		return "", err
	}
	names := make([]string, 0, len(users))
	for u, p := range users {
		if !reNaiveUser.MatchString(u) || !reNaivePass.MatchString(p) {
			return "", fmt.Errorf("пользователь %q: неверное имя или пароль", u)
		}
		names = append(names, u)
	}
	sort.Strings(names)
	var b strings.Builder
	b.WriteString("# Собран vps-agent из config.json и users.json - руками не править\n{\n")
	fmt.Fprintf(&b, "\tadmin unix/%s\n", naiveSock)
	fmt.Fprintf(&b, "\tstorage file_system %s\n", naiveData)
	fmt.Fprintf(&b, "\thttps_port %d\n", c.Port)
	if c.HTTP80 {
		b.WriteString("\thttp_port 80\n")
	} else {
		b.WriteString("\tcert_issuer acme {\n\t\tdisable_http_challenge\n\t}\n")
	}
	b.WriteString("\tauto_https disable_redirects\n")
	b.WriteString("\tservers {\n\t\tprotocols h1 h2\n\t}\n")
	b.WriteString("\tlog {\n\t\tlevel WARN\n\t}\n}\n\n")
	// Адрес без имени (":порт") обязателен: Caddy выбирает сайт по Host, а у запроса через прокси
	// Host - адрес цели (CONNECT example.com:443); имя рядом - чтобы Caddy выпустил сертификат.
	sites := []string{fmt.Sprintf(":%d", c.Port), fmt.Sprintf("https://%s:%d", c.Domain, c.Port)}
	if c.Listen443 {
		sites = append(sites, ":443", fmt.Sprintf("https://%s:443", c.Domain))
	}
	b.WriteString(strings.Join(sites, ", ") + " {\n\troute {\n")
	if len(names) > 0 {
		b.WriteString("\t\tforward_proxy {\n")
		for _, u := range names {
			fmt.Fprintf(&b, "\t\t\tbasic_auth %s %s\n", u, users[u])
		}
		b.WriteString("\t\t\thide_ip\n\t\t\thide_via\n")
		// сам сервер и частные сети клиентам прокси недоступны: на 127.0.0.1 слушают панели
		// 3X-UI и MTProxyL, admin API WDTT; свой внешний адрес изнутри идёт мимо firewall
		b.WriteString("\t\t\tacl {\n")
		for _, n := range append(naivePrivateNets, deny...) {
			fmt.Fprintf(&b, "\t\t\t\tdeny %s\n", n)
		}
		b.WriteString("\t\t\t\tdeny localhost *.localhost\n\t\t\t\tallow all\n\t\t\t}\n")
		fmt.Fprintf(&b, "\t\t\tprobe_resistance %s\n", c.Secret)
		b.WriteString("\t\t}\n")
	}
	b.WriteString(naiveStubRoute("\t\t"))
	b.WriteString("\t}\n}\n")
	if c.HTTP80 {
		fmt.Fprintf(&b, "\nhttp://%s {\n\troute {\n%s\t}\n}\n", c.Domain, naiveStubRoute("\t\t"))
	}
	return b.String(), nil
}

// NaiveLocalIPs - адреса интерфейсов сервера (внешний в том числе) для acl прокси.
func NaiveLocalIPs() []string {
	var out []string
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if n, ok := a.(*net.IPNet); ok && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
			if n.IP.To4() != nil {
				out = append(out, n.IP.String()+"/32")
			} else {
				out = append(out, n.IP.String()+"/128")
			}
		}
	}
	sort.Strings(out)
	return out
}

// naiveStubRoute - заглушка как у обычного сайта: GET и HEAD - страница (на любой путь),
// остальное (CONNECT без пароля в том числе) - 405. На 200 в ответ на CONNECT Chrome считал бы
// тоннель открытым и ловил ERR_SSL_PROTOCOL_ERROR вместо понятной расширению ошибки тоннеля.
func naiveStubRoute(ind string) string {
	return ind + "@page method GET HEAD\n" +
		ind + "root * " + filepath.Join(naiveDir, "www") + "\n" +
		ind + "rewrite @page /index.html\n" +
		ind + "file_server @page\n" +
		ind + "respond 405\n"
}

// naiveWriteStub - страница-заглушка в <naiveDir>/www (группа службы читает); changed - файл
// был другим (новая версия агента принесла новую заглушку).
func naiveWriteStub() (changed bool, err error) {
	dir := filepath.Join(naiveDir, "www")
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return false, err
	}
	if g, err := user.LookupGroup(naiveGroup); err == nil {
		gid, _ := strconv.Atoi(g.Gid)
		_ = os.Chown(dir, 0, gid)
	}
	_ = os.Chmod(dir, 0o750)
	if old, err := os.ReadFile(filepath.Join(dir, "index.html")); err == nil && bytes.Equal(old, naiveStub) {
		return false, nil
	}
	return true, naiveWrite("www/index.html", naiveStub, true)
}

func naiveReadConfig() (NaiveConfig, error) {
	var c NaiveConfig
	b, err := os.ReadFile(filepath.Join(naiveDir, "config.json"))
	if err != nil {
		return c, errors.New("прокси для браузера не установлен: нет " + filepath.Join(naiveDir, "config.json"))
	}
	if err := json.Unmarshal(b, &c); err != nil {
		return c, fmt.Errorf("config.json: %w", err)
	}
	return c, c.check()
}

func naiveReadUsers() (map[string]string, error) {
	users := map[string]string{}
	b, err := os.ReadFile(filepath.Join(naiveDir, "users.json"))
	if errors.Is(err, os.ErrNotExist) {
		return users, nil
	}
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(b, &users); err != nil {
		return nil, fmt.Errorf("users.json: %w", err)
	}
	return users, nil
}

// naiveWrite пишет файл атомарно (через временный рядом) с правами и группой службы.
func naiveWrite(name string, data []byte, groupRead bool) error {
	path := filepath.Join(naiveDir, name)
	tmp := path + ".tmp"
	mode := os.FileMode(0o600)
	if groupRead {
		mode = 0o640
	}
	if err := os.WriteFile(tmp, data, mode); err != nil {
		return err
	}
	if groupRead {
		if g, err := user.LookupGroup(naiveGroup); err == nil {
			gid, _ := strconv.Atoi(g.Gid)
			_ = os.Chown(tmp, 0, gid)
		}
	}
	if err := os.Chmod(tmp, mode); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// NaiveRenderFiles - Caddyfile из файлов на диске (vps-agent -naive-render в команде установки).
func NaiveRenderFiles() error {
	c, err := naiveReadConfig()
	if err != nil {
		return err
	}
	users, err := naiveReadUsers()
	if err != nil {
		return err
	}
	text, err := NaiveRender(c, users, NaiveLocalIPs())
	if err != nil {
		return err
	}
	if _, err := naiveWriteStub(); err != nil {
		return err
	}
	if _, err := os.Stat(filepath.Join(naiveDir, "users.json")); errors.Is(err, os.ErrNotExist) {
		if err := naiveWrite("users.json", []byte("{}\n"), false); err != nil {
			return err
		}
	}
	return naiveWrite("Caddyfile", []byte(text), true)
}

// NaiveRequest - правка пользователей: user.set (имя и пароль) или user.remove (имя).
type NaiveRequest struct {
	Op   string `json:"op"`
	User string `json:"user"`
	Pass string `json:"pass"`
}

var naiveMu sync.Mutex

// NaiveExec меняет пользователя и применяет конфиг: при работающей службе - reload (Caddy
// меняет конфиг атомарно: не принял - работает старый), иначе - проверка конфига. Ошибка -
// файлы возвращаются к прежним.
func NaiveExec(ctx context.Context, p NaiveRequest) (map[string]any, error) {
	if !reNaiveUser.MatchString(p.User) {
		return nil, errors.New("имя пользователя: латиница, цифры, дефис")
	}
	naiveMu.Lock()
	defer naiveMu.Unlock()
	c, err := naiveReadConfig()
	if err != nil {
		return nil, err
	}
	users, err := naiveReadUsers()
	if err != nil {
		return nil, err
	}
	switch p.Op {
	case "user.set":
		if !reNaivePass.MatchString(p.Pass) {
			return nil, errors.New("пароль: 16-64 латинских букв и цифр")
		}
		if users[p.User] == p.Pass {
			return naiveRefresh(ctx, c, users)
		}
		users[p.User] = p.Pass
	case "user.remove":
		if _, ok := users[p.User]; !ok {
			return naiveRefresh(ctx, c, users)
		}
		delete(users, p.User)
	default:
		return nil, errors.New("операция: user.set или user.remove")
	}
	if err := naiveApply(ctx, c, users); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "changed": true}, nil
}

// naiveRefresh - пользователи те же, но новая версия агента могла принести другой шаблон
// Caddyfile или заглушку: тогда применить (сверка зовёт user.set раз в 6 часов - так новые
// версии доезжают до серверов без переустановки).
func naiveRefresh(ctx context.Context, c NaiveConfig, users map[string]string) (map[string]any, error) {
	stub, err := naiveWriteStub()
	if err != nil {
		return nil, err
	}
	text, err := NaiveRender(c, users, NaiveLocalIPs())
	if err != nil {
		return nil, err
	}
	cur, _ := os.ReadFile(filepath.Join(naiveDir, "Caddyfile"))
	if string(cur) == text && !stub {
		return map[string]any{"ok": true, "changed": false}, nil
	}
	if err := naiveApply(ctx, c, users); err != nil {
		return nil, err
	}
	return map[string]any{"ok": true, "changed": true}, nil
}

func naiveApply(ctx context.Context, c NaiveConfig, users map[string]string) error {
	text, err := NaiveRender(c, users, NaiveLocalIPs())
	if err != nil {
		return err
	}
	oldCaddy, _ := os.ReadFile(filepath.Join(naiveDir, "Caddyfile"))
	oldUsers, _ := os.ReadFile(filepath.Join(naiveDir, "users.json"))
	ub, _ := json.MarshalIndent(users, "", "  ")
	restore := func() {
		_ = naiveWrite("users.json", oldUsers, false)
		_ = naiveWrite("Caddyfile", oldCaddy, true)
	}
	if _, err := naiveWriteStub(); err != nil {
		return err
	}
	if err := naiveWrite("users.json", append(ub, '\n'), false); err != nil {
		return err
	}
	if err := naiveWrite("Caddyfile", []byte(text), true); err != nil {
		restore()
		return err
	}
	var res shell.Result
	if strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", "vps-naive")) == "active" {
		res, err = shell.Exec(ctx, 60*time.Second, nil, "systemctl", "reload", "vps-naive")
	} else {
		res, err = shell.Exec(ctx, 60*time.Second, nil, "runuser", "-u", naiveGroup, "--",
			naiveBin, "validate", "--config", filepath.Join(naiveDir, "Caddyfile"), "--adapter", "caddyfile")
	}
	if err != nil || res.ExitCode != 0 {
		restore()
		msg := strings.TrimSpace(res.Stderr + " " + res.Stdout)
		if err != nil {
			msg = err.Error() + " " + msg
		}
		return errors.New("прокси не принял конфиг: " + tail(msg, 400))
	}
	return nil
}

func tail(s string, n int) string {
	if len(s) > n {
		return s[len(s)-n:]
	}
	return s
}

// NaiveStatus - состояние для панели: настройки (с секретным именем - его панель отдаёт
// только в подписке клиента), служба, имена пользователей без паролей, срок сертификата.
func NaiveStatus(ctx context.Context) map[string]any {
	if _, err := os.Stat(naiveUnit); err != nil {
		return map[string]any{"installed": false}
	}
	out := map[string]any{"installed": true, "active": strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", "vps-naive"))}
	c, err := naiveReadConfig()
	if err != nil {
		out["error"] = err.Error()
		return out
	}
	out["domain"], out["port"], out["secret"] = c.Domain, c.Port, c.Secret
	out["listen443"], out["mask443"], out["http80"] = c.Listen443, c.Mask443, c.HTTP80
	users, err := naiveReadUsers()
	if err != nil {
		out["error"] = err.Error()
	}
	names := make([]string, 0, len(users))
	for u := range users {
		names = append(names, u)
	}
	sort.Strings(names)
	out["users"] = names
	if t, ok := NaiveCertExpiry(c.Domain); ok {
		out["certNotAfter"] = t.UTC().Format(time.RFC3339)
	}
	return out
}

// NaiveCertExpiry - срок сертификата имени в хранилище Caddy (выпущен ли он вообще).
func NaiveCertExpiry(domain string) (time.Time, bool) {
	matches, _ := filepath.Glob(filepath.Join(naiveData, "certificates", "*", domain, domain+".crt"))
	var best time.Time
	for _, m := range matches {
		b, err := os.ReadFile(m)
		if err != nil {
			continue
		}
		blk, _ := pem.Decode(b)
		if blk == nil {
			continue
		}
		if cert, err := x509.ParseCertificate(blk.Bytes); err == nil && cert.NotAfter.After(best) {
			best = cert.NotAfter
		}
	}
	return best, !best.IsZero()
}
