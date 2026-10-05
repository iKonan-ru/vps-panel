package certs

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// scanCaddy - сертификаты, которые Caddy в контейнере выпускает и продлевает сам (так живёт
// сертификат домена панели). Только домены, которые Caddy обслуживает сейчас (его API на
// 127.0.0.1:2019 внутри контейнера): в хранилище лежат и старые, которые он уже не продлевает.
// Файлы - в томе, примонтированном в /data: caddy/certificates/<CA>/<домен>/<домен>.crt.
func scanCaddy(ctx context.Context, containers []proto.Container) []proto.Cert {
	var out []proto.Cert
	for _, c := range containers {
		if c.State != "running" || !(c.Image == "caddy" || strings.HasPrefix(c.Image, "caddy:")) {
			continue
		}
		data := caddyDataDir(ctx, c.Name)
		if data == "" {
			continue
		}
		res, err := shell.Exec(ctx, 15*time.Second, nil, "docker", "exec", c.Name,
			"wget", "-qO-", "http://127.0.0.1:2019/config/apps/http/servers")
		if err != nil || res.ExitCode != 0 {
			continue
		}
		for _, host := range caddyHosts(res.Stdout) {
			matches, _ := filepath.Glob(filepath.Join(data, "caddy", "certificates", "*", host, host+".crt"))
			for _, crt := range matches {
				if cert, ok := parse(crt); ok {
					cert.Name, cert.Source, cert.AutoRenew = host, "caddy", true
					cert.KeyPath = strings.TrimSuffix(crt, ".crt") + ".key"
					cert.UsedBy = []string{"docker:" + c.Name}
					out = append(out, cert)
				}
			}
		}
	}
	return out
}

// caddyDataDir - путь на хосте к тому, примонтированному в /data контейнера Caddy.
func caddyDataDir(ctx context.Context, container string) string {
	res, err := shell.Exec(ctx, 15*time.Second, nil, "docker", "inspect", "-f",
		`{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}`, container)
	if err != nil || res.ExitCode != 0 {
		return ""
	}
	return strings.TrimSpace(res.Stdout)
}

// caddyHosts собирает имена из всех "host" в match маршрутов конфига Caddy (без масок *.).
func caddyHosts(text string) []string {
	var cfg any
	if json.Unmarshal([]byte(text), &cfg) != nil {
		return nil
	}
	seen := map[string]bool{}
	var walk func(v any)
	walk = func(v any) {
		switch t := v.(type) {
		case map[string]any:
			for k, x := range t {
				if k == "host" {
					if arr, ok := x.([]any); ok {
						for _, h := range arr {
							if s, ok := h.(string); ok && s != "" && !strings.Contains(s, "*") {
								seen[s] = true
							}
						}
					}
					continue
				}
				walk(x)
			}
		case []any:
			for _, x := range t {
				walk(x)
			}
		}
	}
	walk(cfg)
	hosts := make([]string, 0, len(seen))
	for h := range seen {
		hosts = append(hosts, h)
	}
	sort.Strings(hosts)
	return hosts
}

// naiveData - хранилище Caddy прокси для браузера: service vps-naive.
var naiveData = "/var/lib/vps-naive"

// scanNaive - сертификаты, которые выпустил Caddy прокси для браузера:
// <хранилище>/certificates/<CA>/<имя>/<имя>.crt.
func scanNaive() []proto.Cert {
	var out []proto.Cert
	matches, _ := filepath.Glob(filepath.Join(naiveData, "certificates", "*", "*", "*.crt"))
	for _, crt := range matches {
		host := filepath.Base(filepath.Dir(crt))
		if filepath.Base(crt) != host+".crt" {
			continue
		}
		if cert, ok := parse(crt); ok {
			cert.Name, cert.Source, cert.AutoRenew = host, "naive", true
			cert.KeyPath = strings.TrimSuffix(crt, ".crt") + ".key"
			cert.UsedBy = []string{"naive"}
			out = append(out, cert)
		}
	}
	return out
}
