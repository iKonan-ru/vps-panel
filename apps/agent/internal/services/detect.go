// Package services находит установленные VPN-инструменты и их панели.
package services

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/reach"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
	_ "modernc.org/sqlite"
)

// ContainerKinds - виды сервисов, которые Detect находит по контейнерам docker.
var ContainerKinds = []string{"amnezia", "wg-easy"}

// Detect собирает список сервисов. publicIP нужен для ссылок на панели, xuiInfo - настройки
// 3x-ui (ReadXui, nil - её нет).
func Detect(ctx context.Context, containers []proto.Container, publicIP string, xuiInfo *XuiInfo) []proto.Service {
	var out []proto.Service
	if s, ok := xui(ctx, xuiInfo, publicIP); ok {
		out = append(out, s)
	}
	if s, ok := mtproxyl(ctx, publicIP); ok {
		out = append(out, s)
	}
	out = append(out, amnezia(containers)...)
	if s, ok := wdtt(ctx, publicIP); ok {
		out = append(out, s)
	}
	if s, ok := wireguard(ctx); ok {
		out = append(out, s)
	}
	if s, ok := openflux(ctx); ok {
		out = append(out, s)
	}
	if s, ok := naive(ctx); ok {
		out = append(out, s)
	}
	for _, c := range containers {
		if strings.Contains(c.Name, "wg-easy") {
			s := proto.Service{Kind: "wg-easy", Title: "wg-easy", Ports: c.Published, Details: map[string]any{"container": c.Name, "state": c.State}}
			markDown(&s, containerDown(c), "контейнер "+c.Name+": "+c.State)
			out = append(out, s)
		}
	}
	if out == nil {
		out = []proto.Service{}
	}
	return out
}

// markDown отмечает упавший сервис (health.go): Details["down"] и причина.
func markDown(s *proto.Service, down bool, reason string) {
	if s.Details == nil {
		s.Details = map[string]any{}
	}
	s.Details["down"] = down
	if down && reason != "" {
		s.Details["downReason"] = reason
	}
}

var udpProtocols = map[string]bool{"wireguard": true, "amneziawg": true, "hysteria": true, "tuic": true}
var udpNetworks = map[string]bool{"kcp": true, "mkcp": true, "quic": true}

func findXuiDB(ctx context.Context, containers []proto.Container) string {
	if _, err := os.Stat("/etc/x-ui/x-ui.db"); err == nil {
		return "/etc/x-ui/x-ui.db"
	}
	for _, c := range containers {
		mounts := shell.Out(ctx, "docker", "inspect", "-f", "{{range .Mounts}}{{.Source}}|{{.Destination}}\n{{end}}", c.ID)
		for _, line := range strings.Split(mounts, "\n") {
			src, dst, ok := strings.Cut(line, "|")
			if ok && strings.TrimRight(dst, "/") == "/etc/x-ui" {
				if _, err := os.Stat(src + "/x-ui.db"); err == nil {
					return src + "/x-ui.db"
				}
			}
		}
	}
	return ""
}

// XuiInfo - что нужно другим модулям (port-sync, аудит) про 3x-ui.
type XuiInfo struct {
	Partial     string // что не удалось прочитать (нет psql для PostgreSQL)
	RemoteNodes int    // узлов группового управления с их собственными inbound
	DB          string
	PanelPort   int
	PanelListen string
	HTTPS       bool
	CertFile    string
	KeyFile     string
	BasePath    string
	TwoFactor   bool
	SubPort     int
	SubEnabled  bool
	Inbounds    []XuiInbound
}

type XuiInbound struct {
	Port     int
	Protocol string
	Network  string
	Remark   string
	Protos   []string
}

// ReadXui читает settings и inbounds 3x-ui (только чтение): из sqlite или, если 3x-ui
// настроен на PostgreSQL (/etc/default/x-ui), через psql.
func ReadXui(ctx context.Context, containers []proto.Container) (*XuiInfo, error) {
	cfg := ReadXuiDBConfig()
	var settings map[string]string
	var inbounds [][]string // port, protocol, listen, enable, stream_settings, remark
	info := &XuiInfo{PanelPort: 2053, PanelListen: "0.0.0.0", BasePath: "/", SubPort: 2096}
	if cfg.Type == "postgres" {
		info.DB = "postgres"
		rows, err := pgQuery(ctx, cfg.DSN, "select key, value from settings")
		if err == errPsqlMissing {
			// без psql хотя бы порт, путь и HTTPS из "x-ui setting -show"
			info.Partial = "3X-UI хранит данные в PostgreSQL, а psql не установлен: сертификат и порты inbound панели не видны"
			for _, line := range strings.Split(shell.Out(ctx, "/usr/local/x-ui/x-ui", "setting", "-show"), "\n") {
				k, v, ok := strings.Cut(line, ":")
				if !ok {
					continue
				}
				v = strings.TrimSpace(v)
				switch strings.TrimSpace(k) {
				case "port":
					if n, e := strconv.Atoi(v); e == nil {
						info.PanelPort = n
					}
				case "webBasePath":
					info.BasePath = v
				}
				if strings.Contains(line, "secure with SSL") {
					info.HTTPS = true
				}
			}
			return info, nil
		}
		if err != nil {
			return nil, err
		}
		settings = map[string]string{}
		for _, r := range rows {
			if len(r) == 2 {
				settings[strings.TrimSpace(r[0])] = strings.TrimSpace(r[1])
			}
		}
		nodeCol := "0"
		if rows, err := pgQuery(ctx, cfg.DSN, "select count(*) from information_schema.columns where table_name='inbounds' and column_name='node_id'"); err == nil && len(rows) == 1 && strings.TrimSpace(rows[0][0]) != "0" {
			nodeCol = "coalesce(node_id,0)"
		}
		inbounds, _ = pgQuery(ctx, cfg.DSN, "select port, protocol, coalesce(listen,''), enable, coalesce(stream_settings,''), coalesce(remark,''), "+nodeCol+" from inbounds")
	} else {
		path := findXuiDB(ctx, containers)
		if path == "" {
			return nil, nil
		}
		info.DB = path
		db, err := sql.Open("sqlite", "file:"+path+"?mode=ro&_pragma=query_only(1)")
		if err != nil {
			return nil, err
		}
		defer db.Close()
		rows, err := db.QueryContext(ctx, "select key, value from settings")
		if err != nil {
			return nil, err
		}
		settings = map[string]string{}
		for rows.Next() {
			var k, v string
			if rows.Scan(&k, &v) == nil {
				settings[k] = v
			}
		}
		rows.Close()
		// node_id есть в 3x-ui с групповым управлением: inbound чужого узла на этом сервере не слушает
		nodeCol := "0"
		var n int
		if db.QueryRowContext(ctx, "select count(*) from pragma_table_info('inbounds') where name='node_id'").Scan(&n) == nil && n > 0 {
			nodeCol = "coalesce(node_id,0)"
		}
		rows, err = db.QueryContext(ctx, "select port, protocol, coalesce(listen,''), enable, coalesce(stream_settings,''), coalesce(remark,''), "+nodeCol+" from inbounds")
		if err == nil {
			for rows.Next() {
				var port, node int
				var protocol, listen, stream, remark string
				var enable bool
				if rows.Scan(&port, &protocol, &listen, &enable, &stream, &remark, &node) == nil {
					en := "f"
					if enable {
						en = "t"
					}
					inbounds = append(inbounds, []string{strconv.Itoa(port), protocol, listen, en, stream, remark, strconv.Itoa(node)})
				}
			}
			rows.Close()
		}
	}
	if v, err := strconv.Atoi(settings["webPort"]); err == nil {
		info.PanelPort = v
	}
	if settings["webListen"] != "" {
		info.PanelListen = settings["webListen"]
	}
	info.HTTPS = settings["webCertFile"] != "" && settings["webKeyFile"] != ""
	info.CertFile, info.KeyFile = settings["webCertFile"], settings["webKeyFile"]
	if settings["webBasePath"] != "" {
		info.BasePath = settings["webBasePath"]
	}
	info.TwoFactor = settings["twoFactorEnable"] == "true"
	info.SubEnabled = settings["subEnable"] == "true"
	if v, err := strconv.Atoi(settings["subPort"]); err == nil {
		info.SubPort = v
	}
	remoteNodes := map[string]bool{}
	for _, r := range inbounds {
		if len(r) != 7 {
			continue
		}
		if node := strings.TrimSpace(r[6]); node != "" && node != "0" {
			remoteNodes[node] = true
			continue // inbound другого узла группы: здесь порт не слушает
		}
		port, _ := strconv.Atoi(strings.TrimSpace(r[0]))
		protocol, listen, remark := strings.TrimSpace(r[1]), strings.TrimSpace(r[2]), strings.TrimSpace(r[5])
		en := strings.TrimSpace(r[3])
		enable := en == "t" || en == "true" || en == "1"
		if !enable || port == 0 || protocol == "dokodemo-door" {
			continue
		}
		if firewall.IsLoopback(listen) {
			continue
		}
		var ss struct {
			Network string `json:"network"`
		}
		_ = json.Unmarshal([]byte(r[4]), &ss)
		ib := XuiInbound{Port: port, Protocol: protocol, Network: strings.ToLower(ss.Network), Remark: remark}
		switch {
		case udpProtocols[protocol] || udpNetworks[ib.Network]:
			ib.Protos = []string{"udp"}
		case protocol == "shadowsocks" || protocol == "mixed":
			ib.Protos = []string{"tcp", "udp"}
		default:
			ib.Protos = []string{"tcp"}
		}
		info.Inbounds = append(info.Inbounds, ib)
	}
	info.RemoteNodes = len(remoteNodes)
	return info, nil
}

func xui(ctx context.Context, info *XuiInfo, publicIP string) (proto.Service, bool) {
	if info == nil {
		return proto.Service{}, false
	}
	s := proto.Service{Kind: "xui", Title: "3X-UI", Ports: []string{}}
	s.PanelURL = panelURL(publicIP, info.PanelPort, strings.TrimSuffix(info.BasePath, "/")+"/")
	if info.HTTPS && strings.HasPrefix(s.PanelURL, "http://") {
		// сертификат задан в настройках, но порт не ответил по TLS за таймаут - всё равно https
		s.PanelURL = "https://" + strings.TrimPrefix(s.PanelURL, "http://")
	}
	s.Ports = append(s.Ports, fmt.Sprintf("%d/tcp panel", info.PanelPort))
	if info.SubEnabled {
		s.Ports = append(s.Ports, fmt.Sprintf("%d/tcp sub", info.SubPort))
	}
	// пустой список, а не nil: в JSON nil - null, а панель ждёт массив
	inb := []map[string]any{}
	for _, ib := range info.Inbounds {
		for _, pr := range ib.Protos {
			s.Ports = append(s.Ports, fmt.Sprintf("%d/%s %s", ib.Port, pr, ib.Remark))
		}
		inb = append(inb, map[string]any{"port": ib.Port, "protocol": ib.Protocol, "network": ib.Network, "remark": ib.Remark})
	}
	if info.RemoteNodes > 0 {
		s.Ports = append(s.Ports, fmt.Sprintf("узлов группы: %d", info.RemoteNodes))
	}
	// панель только на 127.0.0.1, вход - через поддомен VPS Panel
	public := !firewall.IsLoopback(info.PanelListen) && info.PanelListen != "localhost"
	s.Details = map[string]any{"panelPublic": public, "panelPort": info.PanelPort, "https": info.HTTPS, "basePath": info.BasePath != "/", "twoFactor": info.TwoFactor, "inbounds": inb, "db": info.DB, "remoteNodes": info.RemoteNodes}
	if info.Partial != "" {
		s.Details["partial"] = info.Partial
	}
	// xray не запущен или падает по кругу - весь VLESS сервера не работает (аудит, панель)
	xs := XrayState(ctx)
	s.Details["xrayDown"] = xs.Down()
	if xs.Down() && xs.Error != "" {
		s.Details["xrayError"] = xs.Error
	}
	reason := "процесс xray не запущен"
	if xs.Running {
		reason = "xray перезапускается по кругу"
	}
	if xs.Error != "" {
		reason = "ошибка xray: " + xs.Error
	}
	markDown(&s, xs.Down(), reason)
	if v := shell.Out(ctx, "sh", "-c", "/usr/local/x-ui/x-ui -v 2>/dev/null | head -1"); v != "" {
		s.Version = v
	}
	return s, true
}

var rePort = regexp.MustCompile(`(?m)^\s*port\s*=\s*(\d+)`)

// MtproxyPort - порт прокси из config.toml или telemt.toml.
func MtproxyPort() int {
	for _, p := range []string{"/opt/mtproxyl/mtproxy/config.toml", "/opt/mtproxyl/mtproxy/telemt.toml"} {
		if b, err := os.ReadFile(p); err == nil {
			if m := rePort.FindSubmatch(b); m != nil {
				v, _ := strconv.Atoi(string(m[1]))
				return v
			}
		}
	}
	return 0
}

// mtReachFile - итог последней проверки "Доступность из России" MTProxyL (его таймер раз в 15
// минут, зонды Globalping в домашних сетях РФ).
const mtReachFile = "/opt/mtproxyl/availability/last.json"

// mtproxylReach - итог проверки MTProxyL и коротко зонды (город, сеть, дошёл ли) - без сырых
// ответов и сертификатов; nil - проверок ещё не было.
func mtproxylReach(path string) map[string]any {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) > 1<<20 {
		return nil
	}
	var v struct {
		CheckedAt  string  `json:"checked_at"`
		Target     string  `json:"target"`
		Level      string  `json:"level"`
		Percentage float64 `json:"percentage"`
		Total      int     `json:"total_probes"`
		Success    int     `json:"success_probes"`
		Error      string  `json:"error"`
		Probes     []struct {
			City       string `json:"city"`
			ASN        int    `json:"asn"`
			Network    string `json:"network"`
			Status     string `json:"status"`
			TLSSuccess bool   `json:"tls_success"`
			Error      string `json:"error"`
			RawOutput  string `json:"raw_output"`
		} `json:"probes"`
	}
	if json.Unmarshal(raw, &v) != nil || v.CheckedAt == "" {
		return nil
	}
	probes := []reach.Probe{}
	for _, p := range v.Probes {
		if p.Status == "" || p.Status == "in-progress" || len(probes) >= 50 {
			continue
		}
		pr := reach.Probe{City: reach.Clip(p.City, 60), ASN: p.ASN, Network: reach.Clip(p.Network, 60), OK: p.Status == "finished" && p.TLSSuccess}
		if !pr.OK {
			e := p.Error
			if e == "" {
				e = reach.LastLine(p.RawOutput)
			}
			if e == "" {
				e = "TLS не получен"
			}
			pr.Error = reach.Clip(e, 160)
		}
		probes = append(probes, pr)
	}
	return map[string]any{
		"probes":    probes,
		"checkedAt": v.CheckedAt,
		"target":    v.Target,
		"level":     v.Level,
		"percent":   v.Percentage,
		"total":     v.Total,
		"ok":        v.Success,
		"error":     v.Error,
	}
}

func mtproxyl(ctx context.Context, publicIP string) (proto.Service, bool) {
	port := MtproxyPort()
	if port == 0 && !shell.Has("mtproxyl") {
		return proto.Service{}, false
	}
	s := proto.Service{Kind: "mtproxyl", Title: "MTProxyL", Ports: []string{}}
	if port > 0 {
		s.Ports = append(s.Ports, fmt.Sprintf("%d/tcp proxy", port))
	}
	for _, l := range firewall.PortsOf(ctx, "mtproxyl-panel") {
		s.Ports = append(s.Ports, fmt.Sprintf("%d/tcp panel", l))
		s.PanelURL = panelURL(publicIP, l, "")
		s.Details = map[string]any{"panelPublic": len(firewall.PublicPortsOf(ctx, "mtproxyl-panel")) > 0}
		break
	}
	markDown(&s, mtproxyDown(ctx, port), fmt.Sprintf("порт прокси %d никто не слушает", port))
	if r := mtproxylReach(mtReachFile); r != nil {
		if s.Details == nil {
			s.Details = map[string]any{}
		}
		s.Details["ruReach"] = r
	}
	s.Version = mtproxylVersion(ctx, mtScript)
	return s, true
}

// mtScript - скрипт MTProxyL (/usr/local/bin/mtproxyl - ссылка на него): версия - его строка
// VERSION="...", та же, что version в mtproxyl status --json.
var mtScript = "/opt/mtproxyl/mtproxyl.sh"

var reMtVersion = regexp.MustCompile(`(?m)^VERSION="([^"]+)"`)

// mtproxylVersion - версия из скрипта; нет файла или строки - mtproxyl status --json (около
// секунды: загружает все настройки).
func mtproxylVersion(ctx context.Context, script string) string {
	if b, err := os.ReadFile(script); err == nil {
		if m := reMtVersion.FindSubmatch(b); m != nil {
			return string(m[1])
		}
	}
	if v := shell.Out(ctx, "sh", "-c", "mtproxyl status --json 2>/dev/null"); v != "" {
		var st map[string]any
		if json.Unmarshal([]byte(v), &st) == nil {
			if ver, ok := st["version"].(string); ok {
				return ver
			}
		}
	}
	return ""
}

func amnezia(containers []proto.Container) []proto.Service {
	var out []proto.Service
	for _, c := range containers {
		if !strings.HasPrefix(c.Name, "amnezia-") || strings.Contains(c.Name, "panel") {
			continue
		}
		s := proto.Service{
			Kind:    "amnezia",
			Title:   "Amnezia " + strings.TrimPrefix(c.Name, "amnezia-"),
			Ports:   c.Published,
			Details: map[string]any{"container": c.Name, "state": c.State},
		}
		markDown(&s, containerDown(c), "контейнер "+c.Name+": "+c.State)
		out = append(out, s)
	}
	return out
}

func wdtt(ctx context.Context, publicIP string) (proto.Service, bool) {
	// установлен - есть служба wdtt, а не слушает ли процесс порт: упавший WDTT пропал бы из
	// списка, и через 30 минут сверка стёрла бы привязки клиентов как у удалённого сервиса
	ports := firewall.PortsOf(ctx, "wdtt-server")
	if len(ports) == 0 && !wdttInstalled() {
		return proto.Service{}, false
	}
	if len(ports) == 0 {
		if p := wdttUnitPort(); p > 0 {
			ports = []int{p}
		}
	}
	sort.Ints(ports)
	s := proto.Service{Kind: "wdtt", Title: "WDTT", Ports: []string{}}
	for _, p := range ports {
		s.Ports = append(s.Ports, strconv.Itoa(p))
	}
	if wdttInstalled() {
		st := unitActive(ctx, "wdtt")
		markDown(&s, st != "active", "служба wdtt: "+st)
	}
	// веб-панели у WDTT нет: admin API - JSON и только на 127.0.0.1, к нему ходит панель через агента
	return s, true
}

func wireguard(ctx context.Context) (proto.Service, bool) {
	var ports []string
	for _, tool := range []string{"wg", "awg"} {
		if !shell.Has(tool) {
			continue
		}
		for _, line := range strings.Split(shell.Out(ctx, tool, "show", "all", "listen-port"), "\n") {
			f := strings.Fields(line)
			// wdtt0 - встроенный WireGuard сервера WDTT, это сервис WDTT, а не отдельный WireGuard
			if len(f) == 2 && strings.HasPrefix(f[0], "wdtt") {
				continue
			}
			if len(f) == 2 {
				ports = append(ports, f[1]+"/udp "+f[0])
			} else if len(f) == 1 && f[0] != "" {
				ports = append(ports, f[0]+"/udp")
			}
		}
	}
	down := wgDownIfaces(ctx)
	if len(ports) == 0 && len(down) == 0 {
		return proto.Service{}, false
	}
	s := proto.Service{Kind: "wireguard", Title: "WireGuard/AWG", Ports: ports}
	if ports == nil {
		s.Ports = []string{}
	}
	markDown(&s, len(down) > 0, "не подняты интерфейсы: "+strings.Join(down, ", "))
	return s, true
}
