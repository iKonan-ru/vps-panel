package baseline

import (
	"context"
	"net"
	"net/url"
	"os"
	"regexp"
	"slices"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/fsutil"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
)

const jailLocal = "/etc/fail2ban/jail.local"

// panelURL - адрес панели из конфига агента. Панель ходит на сервер по SSH (настройка, ключи
// root), и её отказы до входа fail2ban не должен считать перебором: адреса панели - в ignoreip.
var panelURL string

// SetPanelURL - адрес панели из конфига агента, при запуске.
func SetPanelURL(u string) { panelURL = u }

// lookupHost - DNS (тесты подменяют).
var lookupHost = net.DefaultResolver.LookupHost

var reIgnoreIP = regexp.MustCompile(`(?m)^ignoreip\s*=.*$`)

// panelIPs - адреса панели по её имени в DNS (как их видит сама панель); локальные не нужны -
// они в ignoreip всегда. Нет ответа DNS - пусто.
func panelIPs(ctx context.Context) []string {
	u, err := url.Parse(panelURL)
	if err != nil || u.Hostname() == "" {
		return nil
	}
	host := u.Hostname()
	addrs := []string{host}
	if net.ParseIP(host) == nil {
		c, cancel := context.WithTimeout(ctx, 10*time.Second)
		defer cancel()
		if addrs, err = lookupHost(c, host); err != nil {
			return nil
		}
	}
	var out []string
	for _, a := range addrs {
		ip := net.ParseIP(a)
		if ip == nil || ip.IsLoopback() || ip.IsUnspecified() {
			continue
		}
		out = append(out, ip.String())
	}
	slices.Sort(out)
	return slices.Compact(out)
}

// withIgnoreIP - jail.local со строкой ignoreip: локальные адреса и адреса панели.
func withIgnoreIP(jail string, ips []string) string {
	line := strings.Join(append([]string{"ignoreip  = 127.0.0.1/8 ::1"}, ips...), " ")
	return reIgnoreIP.ReplaceAllLiteralString(jail, line)
}

// RefreshFail2banIgnore дописывает адреса панели в ignoreip нашего jail.local (поставленного
// приведением к эталону) и перечитывает fail2ban. Чужой jail.local не трогается; DNS не ответил -
// прежняя строка остаётся. true - строка изменилась.
func RefreshFail2banIgnore(ctx context.Context) (bool, error) {
	path := hostfs.Path(jailLocal)
	cur, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(cur), "VPS Panel") {
		return false, nil
	}
	ips := panelIPs(ctx)
	if len(ips) == 0 {
		return false, nil
	}
	next := withIgnoreIP(string(cur), ips)
	if next == string(cur) {
		return false, nil
	}
	if err := fsutil.WriteAtomic(path, []byte(next), 0o644); err != nil {
		return false, err
	}
	systemctl(ctx, "systemctl is-active --quiet fail2ban && fail2ban-client reload")
	return true, nil
}
