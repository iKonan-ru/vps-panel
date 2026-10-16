package portsync

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/sshd"
)

// Port - порт с протоколом; в JSON - ["tcp", 443].
type Port struct {
	Proto string
	Num   int
}

// Key - "443/tcp".
func (p Port) Key() string { return strconv.Itoa(p.Num) + "/" + p.Proto }

func (p Port) MarshalJSON() ([]byte, error) { return json.Marshal([]any{p.Proto, p.Num}) }

func (p *Port) UnmarshalJSON(b []byte) error {
	var v []json.RawMessage
	if err := json.Unmarshal(b, &v); err != nil || len(v) != 2 {
		return errors.New("порт: нужен [протокол, номер]")
	}
	if err := json.Unmarshal(v[0], &p.Proto); err != nil {
		return err
	}
	return json.Unmarshal(v[1], &p.Num)
}

// Published - опубликованный порт контейнера.
type Published struct {
	Container   string `json:"container"`
	Proto       string `json:"proto"`
	Port        int    `json:"port"`
	HostIP      string `json:"host_ip"`
	NetworkMode string `json:"network_mode"`
}

// Unknown - слушатель наружу, процесса которого нет в known_processes: его порт закрыт.
type Unknown struct {
	Proto   string `json:"proto"`
	Port    int    `json:"port"`
	Process string `json:"process"`
}

// State - желаемое состояние: что открыть на хосте и для контейнеров, подписи правил, замечания.
type State struct {
	SSHPort               int               `json:"ssh_port"`
	HostAllow             []Port            `json:"host_allow"`
	DockerAllow           []Port            `json:"docker_allow"`
	Labels                map[string]string `json:"labels"`
	DockerLabels          map[string]string `json:"docker_labels"`
	DockerPublished       []Published       `json:"docker_published"`
	HostNetworkContainers []string          `json:"host_network_containers"`
	Deny                  []Port            `json:"deny"`
	UnknownListeners      []Unknown         `json:"unknown_listeners"`
	AdminIPs              []string          `json:"admin_ips"`
	AllowPing             bool              `json:"allow_ping"`
	Xui                   map[string]any    `json:"xui"`
	Mtproxy               map[string]any    `json:"mtproxy"`
	WireguardPorts        []int             `json:"wireguard_ports"`
	// Findings - [важность, текст]
	Findings     [][2]string `json:"findings"`
	WanInterface string      `json:"wan_interface"`
	// XuiFP - отпечаток 3x-ui (services.XuiInfo.Fingerprint), "" - 3x-ui не прочитан
	XuiFP string `json:"xui_fp"`
}

// Allowed - порты ("443/tcp"), которые откроет port-sync: хост и контейнеры.
func (s *State) Allowed() map[string]bool {
	out := map[string]bool{}
	for _, p := range append(append([]Port{}, s.HostAllow...), s.DockerAllow...) {
		out[p.Key()] = true
	}
	return out
}

type portSet map[Port]bool

func (s portSet) add(o portSet) {
	for p := range o {
		s[p] = true
	}
}

func (s portSet) sub(o portSet) {
	for p := range o {
		delete(s, p)
	}
}

func (s portSet) sorted() []Port {
	out := []Port{}
	for p := range s {
		out = append(out, p)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Proto != out[j].Proto {
			return out[i].Proto < out[j].Proto
		}
		return out[i].Num < out[j].Num
	})
	return out
}

// labelMap - подписи правил; первая подпись порта побеждает (setDefault).
type labelMap map[Port]string

func (l labelMap) setDefault(p Port, v string) {
	if _, ok := l[p]; !ok {
		l[p] = v
	}
}

func (l labelMap) only(allowed portSet) map[string]string {
	out := map[string]string{}
	for p, v := range l {
		if allowed[p] {
			out[p.Key()] = v
		}
	}
	return out
}

// parsePort: "443/tcp" -> tcp 443, без протокола - tcp.
func parsePort(spec string) (Port, error) {
	spec = strings.TrimSpace(spec)
	port, pr, ok := strings.Cut(spec, "/")
	if !ok {
		pr = "tcp"
	}
	n, err := strconv.Atoi(strings.TrimSpace(port))
	if err != nil {
		return Port{}, fmt.Errorf("порт %q в конфиге port-sync", spec)
	}
	return Port{Proto: strings.ToLower(pr), Num: n}, nil
}

func parsePorts(specs []string) (portSet, error) {
	out := portSet{}
	for _, s := range specs {
		p, err := parsePort(s)
		if err != nil {
			return nil, err
		}
		out[p] = true
	}
	return out, nil
}

// Compute считает желаемое состояние по конфигу и тому, что сейчас установлено на сервере.
// Ошибка (например, база 3x-ui не прочиталась) - состояния нет, и применять нечего: иначе
// port-sync закрыл бы порты, о которых просто не узнал.
func Compute(ctx context.Context, cfg Config) (*State, error) {
	var findings [][2]string
	deny, err := parsePorts(cfg.DenyPublicPorts)
	if err != nil {
		return nil, err
	}
	extra, err := parsePorts(cfg.ExtraAllow)
	if err != nil {
		return nil, err
	}
	sshp := cfg.SSHPort
	if sshp <= 0 {
		// sshd нет - 22; есть, но sshd -T не отработал вовремя - порт неизвестен
		sshp = 22
		if shell.Has("sshd") {
			out, _, err := shell.Output(ctx, "sshd", "-T")
			if err != nil {
				return nil, err
			}
			sshp = sshd.ParseFirstPort(out)
		}
	}
	containers, err := runningContainers(ctx)
	if err != nil {
		return nil, err
	}

	xr, err := readXui(ctx, containers, &findings)
	if err != nil {
		return nil, err
	}
	mtPorts, mtInfo, err := mtproxyPorts(ctx)
	if err != nil {
		return nil, err
	}
	ssh := Port{"tcp", sshp}
	labels := labelMap{ssh: "SSH"}
	for k, v := range xr.labels {
		labels.setDefault(k, v)
	}
	for k := range mtPorts {
		labels.setDefault(k, "MTProxyL")
	}
	wg, err := wireguardPorts(ctx, labels)
	if err != nil {
		return nil, err
	}
	of := openfluxPorts(labels)
	published := dockerPublished(containers)
	listeners, err := firewall.ListenersStrict(ctx)
	if err != nil {
		return nil, err
	}
	procPorts, unknown := processPorts(cfg.KnownProcesses, listeners, labels)
	procPorts.sub(wdttInternalPorts())
	for k := range extra {
		labels.setDefault(k, "вручную (extra_allow)")
	}

	host := portSet{ssh: true}
	for _, s := range []portSet{xr.public, xr.panel, mtPorts, wg, of, procPorts, extra} {
		host.add(s)
	}
	host.sub(deny)
	dropInvalid(host, labels, &findings)
	unknownLeft := []Unknown{}
	for _, u := range unknown {
		if !host[Port{u.Proto, u.Port}] {
			unknownLeft = append(unknownLeft, u)
		}
	}

	dock := portSet{}
	dockLabels := labelMap{}
	if cfg.DockerPolicy == "published" {
		for _, p := range published {
			key := Port{p.Proto, p.Port}
			if deny[key] {
				continue
			}
			dock[key] = true
			dockLabels.setDefault(key, p.Container)
		}
	}
	for k := range extra {
		dockLabels.setDefault(k, "вручную (extra_allow)")
	}
	dock.add(extra)
	dock.sub(deny)
	dropInvalid(dock, dockLabels, &findings)
	dropInvalid(deny, nil, &findings)

	if len(xr.panel) > 0 {
		if https, _ := xr.info["panel_https"].(bool); !https {
			findings = append(findings, [2]string{"high", "3x-ui: панель открыта в интернет БЕЗ HTTPS (webCertFile пуст)"})
		}
		if bp, _ := xr.info["panel_base_path"].(string); bp == "/" || bp == "" {
			findings = append(findings, [2]string{"medium", "3x-ui: панель открыта в интернет с webBasePath '/', нужен длинный путь"})
		}
		if tfa, _ := xr.info["panel_2fa"].(bool); !tfa {
			findings = append(findings, [2]string{"info", "3x-ui: 2FA в панели выключена (Settings -> Security)"})
		}
	}

	wgList := []int{}
	for _, p := range wg.sorted() {
		wgList = append(wgList, p.Num)
	}
	admin := cfg.AdminIPs
	if admin == nil {
		admin = []string{}
	}
	if findings == nil {
		findings = [][2]string{}
	}
	wan := wanInterface(ctx, cfg)
	// дедлайн истёк по ходу: часть команд могла не отработать, и состояние неполное
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("port-sync: расчёт не уложился во время: %w", err)
	}
	return &State{
		SSHPort:               sshp,
		HostAllow:             host.sorted(),
		DockerAllow:           dock.sorted(),
		Labels:                labels.only(host),
		DockerLabels:          dockLabels.only(dock),
		DockerPublished:       published,
		HostNetworkContainers: hostNetworkContainers(containers),
		Deny:                  deny.sorted(),
		UnknownListeners:      unknownLeft,
		AdminIPs:              admin,
		AllowPing:             cfg.AllowPing,
		Xui:                   xr.info,
		Mtproxy:               mtInfo,
		WireguardPorts:        wgList,
		Findings:              findings,
		WanInterface:          wan,
		XuiFP:                 xr.fp,
	}, nil
}

// runningContainers - запущенные контейнеры; docker есть, но не ответил - ошибка: иначе цепочка
// VPS-PORTSYNC закрыла бы порты контейнеров.
func runningContainers(ctx context.Context) ([]dockerapi.Running, error) {
	if !dockerapi.Available() {
		return nil, nil
	}
	list, err := dockerapi.New().RunningContainers(ctx)
	if err != nil {
		return nil, fmt.Errorf("контейнеры docker не прочитаны: %w", err)
	}
	return list, nil
}

// dropInvalid убирает порты, которые ufw и iptables не примут (вне 1-65535, протокол не tcp и не
// udp), с замечанием: остальное применяется.
func dropInvalid(set portSet, labels labelMap, findings *[][2]string) {
	for _, p := range set.sorted() {
		if p.Num >= 1 && p.Num <= 65535 && (p.Proto == "tcp" || p.Proto == "udp") {
			continue
		}
		delete(set, p)
		what := p.Key()
		if l := labels[p]; l != "" {
			what += " (" + l + ")"
		}
		*findings = append(*findings, [2]string{"medium", "port-sync: порт " + what + " пропущен: нужен номер 1-65535 и протокол tcp или udp"})
	}
}

var anyAddr = map[string]bool{"": true, "0.0.0.0": true, "::": true}

type xuiResult struct {
	public, panel portSet
	labels        labelMap
	info          map[string]any
	fp            string
}

// readXui - порты 3x-ui: inbound-ы и подписки (public), панель (panel), подписи и сведения.
func readXui(ctx context.Context, containers []dockerapi.Running, findings *[][2]string) (xuiResult, error) {
	r := xuiResult{public: portSet{}, panel: portSet{}, labels: labelMap{}, info: map[string]any{}}
	x, err := services.ReadXuiWith(ctx, func() string { return findXuiDB(containers) })
	if err != nil {
		return r, fmt.Errorf("3x-ui: не удалось прочитать базу: %w", err)
	}
	if x == nil {
		return r, nil
	}
	if x.Partial != "" {
		r.info["db"] = "postgres"
		*findings = append(*findings, [2]string{"high", "3x-ui хранит данные в PostgreSQL, а psql не установлен: порты inbound не открыты"})
		return r, nil
	}
	if x.InboundsErr != nil {
		return r, fmt.Errorf("3x-ui: не удалось прочитать inbound-ы: %w", x.InboundsErr)
	}
	r.fp = x.Fingerprint
	r.info["db"] = x.DB
	webListen := x.Settings["webListen"]
	r.info["panel_port"] = x.PanelPort
	r.info["panel_listen"] = x.PanelListen
	r.info["panel_https"] = x.HTTPS
	r.info["panel_base_path"] = x.BasePath
	r.info["panel_2fa"] = x.TwoFactor
	// панель на 127.0.0.1 (вход через VPS Panel) - порт снаружи не нужен
	if anyAddr[webListen] {
		p := Port{"tcp", x.PanelPort}
		r.panel[p] = true
		r.labels[p] = "3X-UI панель"
	}
	if x.SubEnabled {
		r.info["sub_port"] = x.SubPort
		if anyAddr[x.Settings["subListen"]] {
			p := Port{"tcp", x.SubPort}
			r.public[p] = true
			r.labels[p] = "3X-UI подписки"
		}
	}
	inbounds := []map[string]any{}
	for _, ib := range x.Inbounds {
		label := labelText(ib.Remark, 28)
		if label == "" {
			label = ib.Protocol
		}
		for _, pr := range ib.Protos {
			p := Port{pr, ib.Port}
			r.public[p] = true
			r.labels[p] = "3X-UI " + label
		}
		inbounds = append(inbounds, map[string]any{"port": ib.Port, "protocol": ib.Protocol, "network": ib.Network, "remark": ib.Remark})
	}
	r.info["inbounds"] = inbounds
	return r, nil
}

// findXuiDB - база 3x-ui: нативная установка или том /etc/x-ui запущенного контейнера.
func findXuiDB(containers []dockerapi.Running) string {
	if _, err := os.Stat(services.XuiNativeDB()); err == nil {
		return services.XuiNativeDB()
	}
	for _, c := range containers {
		for _, m := range c.Mounts {
			if m.Source != "" && strings.TrimRight(m.Destination, "/") == "/etc/x-ui" {
				cand := filepath.Join(m.Source, "x-ui.db")
				if _, err := os.Stat(cand); err == nil {
					return cand
				}
			}
		}
	}
	return ""
}

// mtproxyPorts - порт MTProxyL: из config.toml (telemt.toml), иначе из mtproxyl status --json.
// mtproxyl не завершился вовремя - ошибка; вышел с ошибкой - порта нет.
func mtproxyPorts(ctx context.Context) (portSet, map[string]any, error) {
	ports := portSet{}
	info := map[string]any{}
	if port, path := services.MtproxyConfig(); path != "" {
		ports[Port{"tcp", port}] = true
		info["config"] = path
	} else if shell.Has("mtproxyl") {
		out, code, err := shell.Output(ctx, "mtproxyl", "status", "--json")
		if err != nil {
			return nil, nil, err
		}
		if code == 0 && strings.TrimSpace(out) != "" {
			if n, ok := statusPort(out); ok {
				ports[Port{"tcp", n}] = true
				info["source"] = "mtproxyl status --json"
			}
		}
	}
	if len(ports) > 0 {
		var list []int
		for _, p := range ports.sorted() {
			list = append(list, p.Num)
		}
		info["ports"] = list
	}
	return ports, info, nil
}

// wireguardPorts - WireGuard и AmneziaWG в ядре (не в контейнерах).
func wireguardPorts(ctx context.Context, labels labelMap) (portSet, error) {
	ports := portSet{}
	list, err := services.WgListenPorts(ctx)
	if err != nil {
		return nil, err
	}
	for _, w := range list {
		p := Port{"udp", w.Port}
		ports[p] = true
		switch {
		case w.Iface == "":
			labels.setDefault(p, "WireGuard")
		case strings.HasPrefix(w.Iface, "wdtt"):
			// wdtt0 - встроенный WireGuard сервера WDTT
			labels.setDefault(p, "WDTT")
		default:
			labels.setDefault(p, "WireGuard "+w.Iface)
		}
	}
	return ports, nil
}

// wdttUnits - где может лежать служба wdtt.
var wdttUnits = []string{"/etc/systemd/system/wdtt.service", "/lib/systemd/system/wdtt.service", "/usr/lib/systemd/system/wdtt.service"}

// wdttInternalPorts - WireGuard сервера WDTT (-wg-port): только внутри сервера, снаружи к нему
// ходят через DTLS-порт. wdtt-server слушает его на 0.0.0.0, и без исключения порт открывался бы,
// как прочие порты процесса.
func wdttInternalPorts() portSet {
	out := portSet{}
	for _, path := range wdttUnits {
		b, err := os.ReadFile(hostfs.Path(path))
		if err != nil {
			continue
		}
		for _, n := range services.WdttFlagPorts(string(b))["wg-port"] {
			out[Port{"udp", n}] = true
		}
	}
	return out
}

// openfluxPorts - каналы OpenFlux, TCP. Порт открыт и тогда, когда процесс упал: канал установлен,
// клиенты придут, как только он поднимется.
func openfluxPorts(labels labelMap) portSet {
	out := portSet{}
	for _, c := range services.OpenfluxPorts() {
		if c.Port > 0 && c.Port < 65536 {
			p := Port{"tcp", c.Port}
			out[p] = true
			labels.setDefault(p, "OpenFlux "+c.Channel)
		}
	}
	return out
}

// processLabels - имя процесса -> сервис в подписи правила.
var processLabels = [][2]string{
	{"sshd", "SSH"}, {"xray*", "3X-UI"}, {"x-ui", "3X-UI"}, {"telemt", "MTProxyL"},
	{"mtproxyl*", "MTProxyL"}, {"wdtt*", "WDTT"}, {"openflux*", "OpenFlux"}, {"caddy", "Caddy"},
	{"vps-agent", "VPS Panel агент"},
}

func processLabel(proc string) string {
	for _, l := range processLabels {
		if fnmatch(proc, l[0]) {
			return l[1]
		}
	}
	return proc
}

// processPorts - порты процессов из known_processes и слушатели остальных процессов.
func processPorts(known []string, listeners []proto.Listener, labels labelMap) (portSet, []Unknown) {
	allowed := portSet{}
	var unknown []Unknown
	for _, l := range listeners {
		// опубликованные порты контейнеров - отдельно, в DOCKER-USER
		if l.Process == "docker-proxy" {
			continue
		}
		ok := false
		for _, pat := range known {
			if fnmatch(l.Process, pat) {
				ok = true
				break
			}
		}
		if ok {
			p := Port{l.Proto, l.Port}
			allowed[p] = true
			labels.setDefault(p, processLabel(l.Process))
		} else {
			unknown = append(unknown, Unknown{Proto: l.Proto, Port: l.Port, Process: l.Process})
		}
	}
	return allowed, unknown
}

// dockerPublished - опубликованные порты контейнеров (кроме привязок к 127.0.0.1).
func dockerPublished(containers []dockerapi.Running) []Published {
	out := []Published{}
	for _, c := range containers {
		for _, cport := range c.PortKeys {
			pr := "tcp"
			if _, after, ok := strings.Cut(cport, "/"); ok {
				pr = after
			}
			for _, b := range c.PortBindings[cport] {
				if b.HostPort == "" || strings.HasPrefix(b.HostIP, "127.") || b.HostIP == "::1" {
					continue
				}
				n, err := strconv.Atoi(b.HostPort)
				if err != nil {
					continue
				}
				out = append(out, Published{Container: c.Name, Proto: pr, Port: n, HostIP: b.HostIP, NetworkMode: c.NetworkMode})
			}
		}
	}
	return out
}

func hostNetworkContainers(containers []dockerapi.Running) []string {
	out := []string{}
	for _, c := range containers {
		if c.NetworkMode == "host" {
			out = append(out, c.Name)
		}
	}
	return out
}

var reDev = regexp.MustCompile(`\bdev\s+(\S+)`)

// wanInterface - внешний интерфейс: из конфига или маршрута в интернет, eth0 по умолчанию.
func wanInterface(ctx context.Context, cfg Config) string {
	if cfg.WanInterface != "" {
		return cfg.WanInterface
	}
	if m := reDev.FindStringSubmatch(shell.Out(ctx, "ip", "-o", "route", "get", "1.1.1.1")); m != nil {
		return m[1]
	}
	return "eth0"
}
