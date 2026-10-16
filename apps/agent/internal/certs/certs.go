// Package certs - TLS-сертификаты сервера: только обнаружение и сроки (acme.sh, certbot, то,
// на что указывают 3X-UI и панель MTProxyL, Caddy, прокси для браузера). Агент сертификаты не
// выпускает: HTTPS панелей сервисов даёт Caddy панели (поддомены), VPN их не требует.
package certs

import (
	"bytes"
	"context"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

const acmeHome = "/root/.acme.sh"

// Scan собирает сертификаты со всех известных мест. containers и xui - из того же снимка
// (inventory): список контейнеров для Caddy, настройки 3x-ui (nil - её нет).
func Scan(ctx context.Context, containers []proto.Container, xui *services.XuiInfo) []proto.Cert {
	seen := map[string]bool{}
	var out []proto.Cert
	add := func(c proto.Cert) {
		if c.Path == "" || seen[c.Path] {
			return
		}
		seen[c.Path] = true
		out = append(out, c)
	}
	// acme.sh (его ставит и 3x-ui): /root/.acme.sh/<domain>_ecc/<domain>.cer или fullchain.cer
	if entries, err := os.ReadDir(acmeHome); err == nil {
		for _, e := range entries {
			if !e.IsDir() || strings.HasPrefix(e.Name(), ".") || e.Name() == "deploy" || e.Name() == "dnsapi" || e.Name() == "notify" || e.Name() == "ca" {
				continue
			}
			d := filepath.Join(acmeHome, e.Name())
			full := filepath.Join(d, "fullchain.cer")
			if c, ok := parse(full); ok {
				c.Name, c.Source, c.AutoRenew = strings.TrimSuffix(e.Name(), "_ecc"), "acme.sh", acmeCronPresent()
				c.KeyPath = filepath.Join(d, strings.TrimSuffix(e.Name(), "_ecc")+".key")
				add(c)
			}
		}
	}
	// 3x-ui кладёт установленные копии в /root/cert/<domain>/
	if entries, err := os.ReadDir("/root/cert"); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			full := filepath.Join("/root/cert", e.Name(), "fullchain.pem")
			if c, ok := parse(full); ok {
				c.Name, c.Source, c.AutoRenew = e.Name(), "acme.sh", acmeCronPresent()
				c.KeyPath = filepath.Join("/root/cert", e.Name(), "privkey.pem")
				add(c)
			}
		}
	}
	// certbot
	if entries, err := os.ReadDir("/etc/letsencrypt/live"); err == nil {
		for _, e := range entries {
			if !e.IsDir() {
				continue
			}
			full := filepath.Join("/etc/letsencrypt/live", e.Name(), "fullchain.pem")
			if c, ok := parse(full); ok {
				c.Name, c.Source, c.AutoRenew = e.Name(), "certbot", shell.OK(ctx, "systemctl", "is-active", "certbot.timer")
				c.KeyPath = filepath.Join("/etc/letsencrypt/live", e.Name(), "privkey.pem")
				add(c)
			}
		}
	}
	// то, на что указывает 3x-ui
	if xui != nil && xui.CertFile != "" {
		if c, ok := parse(xui.CertFile); ok {
			c.Name, c.Source, c.KeyPath = "x-ui", "xui", xui.KeyFile
			add(c)
		}
		for i := range out {
			if samePath(out[i].Path, xui.CertFile) && !slices.Contains(out[i].UsedBy, "xui") {
				out[i].UsedBy = append(out[i].UsedBy, "xui")
			}
		}
	}
	// то, на что указывает веб-панель MTProxyL
	mt := readMtproxylPanel()
	if mt.CertFile != "" {
		if c, ok := parse(mt.CertFile); ok {
			c.Name, c.Source, c.KeyPath = "mtproxyl-panel", "mtproxyl", mt.KeyFile
			// панель сама продлевает только через свой ACME (acme_domain)
			c.AutoRenew = mt.AcmeDomain != ""
			add(c)
		}
		for i := range out {
			if samePath(out[i].Path, mt.CertFile) && !slices.Contains(out[i].UsedBy, "mtproxyl") {
				out[i].UsedBy = append(out[i].UsedBy, "mtproxyl")
			}
		}
	}
	// выпущенные и продлеваемые самим Caddy (сертификат домена панели)
	for _, c := range scanCaddy(ctx, containers) {
		add(c)
	}
	// прокси для браузера (служба vps-naive): Caddy сам выпускает и продлевает сертификат имени
	for _, c := range scanNaive() {
		add(c)
	}
	// внутренние записи acme.sh (/root/.acme.sh/<имя>_ecc) - хранилище, из которого acme.sh
	// устанавливает копии (у 3x-ui - в /root/cert). Пока копия с теми же
	// именами есть в списке, запись не показываем: работать нужно с копией, а запись удалять нельзя.
	filtered := make([]proto.Cert, 0, len(out))
	for _, c := range out {
		if strings.HasPrefix(c.Path, acmeHome+"/") {
			hasCopy := false
			for _, o := range out {
				if o.Path != c.Path && !strings.HasPrefix(o.Path, acmeHome+"/") && sameSubjects(o.Subjects, c.Subjects) {
					hasCopy = true
					break
				}
			}
			if hasCopy {
				continue
			}
		}
		filtered = append(filtered, c)
	}
	out = filtered
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	if out == nil {
		out = []proto.Cert{}
	}
	return out
}

func parse(path string) (proto.Cert, bool) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return proto.Cert{}, false
	}
	block, _ := pem.Decode(raw)
	if block == nil {
		return proto.Cert{}, false
	}
	x, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return proto.Cert{}, false
	}
	subjects := append([]string{}, x.DNSNames...)
	for _, ip := range x.IPAddresses {
		subjects = append(subjects, ip.String())
	}
	if len(subjects) == 0 && x.Subject.CommonName != "" {
		subjects = []string{x.Subject.CommonName}
	}
	issuer := x.Issuer.CommonName
	if issuer == "" && len(x.Issuer.Organization) > 0 {
		issuer = x.Issuer.Organization[0]
	}
	if bytes.Equal(x.RawIssuer, x.RawSubject) {
		issuer = "самоподписанный"
	}
	return proto.Cert{
		Path:      path,
		Subjects:  subjects,
		Issuer:    issuer,
		NotBefore: x.NotBefore.UTC().Format(time.RFC3339),
		NotAfter:  x.NotAfter.UTC().Format(time.RFC3339),
		DaysLeft:  int(time.Until(x.NotAfter).Hours() / 24),
		UsedBy:    []string{},
	}, true
}

func acmeCronPresent() bool {
	out, _ := os.ReadFile("/var/spool/cron/crontabs/root")
	return strings.Contains(string(out), ".acme.sh")
}

func samePath(a, b string) bool {
	ra, _ := filepath.EvalSymlinks(a)
	rb, _ := filepath.EvalSymlinks(b)
	return a == b || (ra != "" && ra == rb)
}

func sameSubjects(a, b []string) bool {
	if len(a) != len(b) || len(a) == 0 {
		return false
	}
	m := map[string]bool{}
	for _, x := range a {
		m[x] = true
	}
	for _, x := range b {
		if !m[x] {
			return false
		}
	}
	return true
}
