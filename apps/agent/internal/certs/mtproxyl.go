package certs

import (
	"os"
	"regexp"
	"strings"
)

// Веб-панель MTProxyL работает под своим пользователем и читает сертификат из
// /var/lib/mtproxyl-panel/certs, конфиг - /etc/mtproxyl-panel/config.toml, секция [tls].
// По умолчанию установщик поднимает её на самоподписанном (self_signed = true).
// Делаем то же, что "mtproxyl panel cert": копия файлов панели и пути в [tls].
const (
	mtPanelConfig = "/etc/mtproxyl-panel/config.toml"
)

type mtPanelTLS struct {
	CertFile   string
	KeyFile    string
	AcmeDomain string
}

var mtKeyRe = regexp.MustCompile(`^\s*([a-z_]+)\s*=\s*(.*?)\s*$`)

// readMtproxylPanel читает секцию [tls] конфига панели; пустой результат - панели нет.
func readMtproxylPanel() mtPanelTLS {
	var out mtPanelTLS
	raw, err := os.ReadFile(mtPanelConfig)
	if err != nil {
		return out
	}
	inTLS := false
	for _, line := range strings.Split(string(raw), "\n") {
		t := strings.TrimSpace(line)
		if strings.HasPrefix(t, "[") {
			inTLS = t == "[tls]"
			continue
		}
		if !inTLS {
			continue
		}
		m := mtKeyRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		val := strings.Trim(m[2], `"`)
		switch m[1] {
		case "cert_file":
			out.CertFile = val
		case "key_file":
			out.KeyFile = val
		case "acme_domain":
			out.AcmeDomain = val
		}
	}
	return out
}
