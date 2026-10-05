package adapters

import (
	"context"
	"os"
	"path"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// AmneziaWG в контейнерах приложения Amnezia: amnezia-awg2 (amneziawg-go, awg0.conf),
// легаси amnezia-awg (amnezia-wg, wg0.conf) и дополнительные amnezia-awg2-<порт> панели.
// Только чтение: файлы конфига и clientsTable, пиры из "awg show dump".

const awgDir = "/opt/amnezia/awg"

// AwgParam - строка [Interface]; Commented - параметр записан комментарием "# I1 = ..."
// (так приложение хранит I1-I5 на сервере, чтобы awg-quick их не применял).
type AwgParam struct {
	Key       string `json:"key"`
	Value     string `json:"value"`
	Commented bool   `json:"commented,omitempty"`
}

// AwgClient - пир сервера и/или запись clientsTable. Приватные ключи и PSK наружу не отдаются.
type AwgClient struct {
	PublicKey  string `json:"publicKey"`
	Name       string `json:"name"`
	Device     string `json:"device,omitempty"` // android, ios, windows, ... (userData.device)
	Created    string `json:"created"`
	AllowedIPs string `json:"allowedIps"`
	InConfig   bool   `json:"inConfig"`
	InTable    bool   `json:"inTable"`
	Disabled   bool   `json:"disabled"`
	Endpoint   string `json:"endpoint"`
	Handshake  int64  `json:"handshake"`
	Rx         int64  `json:"rx"`
	Tx         int64  `json:"tx"`
}

// AwgInstance - один контейнер AWG.
type AwgInstance struct {
	Container  string      `json:"container"`
	State      string      `json:"state"`
	ConfPath   string      `json:"confPath"`
	Iface      string      `json:"iface"`
	Port       int         `json:"port"`
	Address    string      `json:"address"`
	Params     []AwgParam  `json:"params"`
	Version    string      `json:"version"`
	PublicKey  string      `json:"publicKey"`
	Impl       string      `json:"impl"`
	Tools      string      `json:"tools"`
	Clients    []AwgClient `json:"clients"`
	TableError string      `json:"tableError,omitempty"`
	Error      string      `json:"error,omitempty"`

	// прочитанные конфиг и clientsTable: AwgConfigData не читает их второй раз
	conf, table string
}

// AwgStatus - всё для вкладки AWG; HostModule - версия модуля amneziawg на хосте, если загружен.
type AwgStatus struct {
	Instances  []AwgInstance `json:"instances"`
	HostModule string        `json:"hostModule"`
	// Docker - список контейнеров получен: пустой Instances тогда значит "контейнеров нет",
	// а не "docker не ответил" (панель по нему чистит ключи клиентов удалённых контейнеров)
	Docker bool `json:"docker"`
}

var reAwgContainer = regexp.MustCompile(`^amnezia-awg[0-9]*(-[0-9]{1,5})?$`)

// AwgStatusAll опрашивает все контейнеры AWG параллельно.
func AwgStatusAll(ctx context.Context) AwgStatus {
	out := AwgStatus{Instances: []AwgInstance{}}
	if b, err := os.ReadFile("/sys/module/amneziawg/version"); err == nil {
		out.HostModule = strings.TrimSpace(string(b))
	}
	if !dockerapi.Available() {
		return out
	}
	list, err := dockerapi.New().List(ctx)
	if err != nil {
		return out
	}
	out.Docker = true
	var mu sync.Mutex
	var wg sync.WaitGroup
	for _, c := range list {
		if !reAwgContainer.MatchString(c.Name) {
			continue
		}
		wg.Add(1)
		go func(name, state string) {
			defer wg.Done()
			inst := awgInstance(ctx, name, state)
			mu.Lock()
			out.Instances = append(out.Instances, inst)
			mu.Unlock()
		}(c.Name, c.State)
	}
	wg.Wait()
	sort.Slice(out.Instances, func(i, j int) bool { return out.Instances[i].Container < out.Instances[j].Container })
	return out
}

func dexec(ctx context.Context, container string, args ...string) (string, bool) {
	res, err := shell.Exec(ctx, 20*time.Second, nil, "docker", append([]string{"exec", container}, args...)...)
	if err != nil || res.ExitCode != 0 {
		return strings.TrimSpace(res.Stderr + res.Stdout), false
	}
	return res.Stdout, true
}

// readAwgConf - конфиг сервера в контейнере: awg0.conf (amnezia-awg2) или wg0.conf (легаси
// amnezia-awg). Нет ни того, ни другого - пустой путь.
func readAwgConf(ctx context.Context, container string) (confPath, text string) {
	for _, f := range []string{"awg0.conf", "wg0.conf"} {
		if text, ok := dexec(ctx, container, "cat", path.Join(awgDir, f)); ok {
			return path.Join(awgDir, f), text
		}
	}
	return "", ""
}

// awgTool - утилита интерфейса: в новых образах awg, в легаси amnezia-wg - wg.
func awgTool(ctx context.Context, container string) string {
	if _, ok := dexec(ctx, container, "awg", "--version"); ok {
		return "awg"
	}
	return "wg"
}

// awgPSK - общий PresharedKey экземпляра (файл приложения), пусто - если файла нет.
func awgPSK(ctx context.Context, container string) string {
	if text, ok := dexec(ctx, container, "cat", path.Join(awgDir, "wireguard_psk.key")); ok {
		return strings.TrimSpace(text)
	}
	return ""
}

func awgInstance(ctx context.Context, name, state string) AwgInstance {
	inst := AwgInstance{Container: name, State: state, Params: []AwgParam{}, Clients: []AwgClient{}}
	if state != "running" {
		inst.Error = "контейнер не запущен"
		return inst
	}
	var conf string
	inst.ConfPath, conf = readAwgConf(ctx, name)
	inst.conf = conf
	if inst.ConfPath == "" {
		inst.Error = "нет " + awgDir + "/awg0.conf и wg0.conf"
		return inst
	}
	inst.Iface = strings.TrimSuffix(path.Base(inst.ConfPath), ".conf")
	params, peers := parseAwgConf(conf)
	for _, p := range params {
		switch p.Key {
		case "PrivateKey":
			continue // ключ сервера не покидает сервер
		case "ListenPort":
			inst.Port, _ = strconv.Atoi(p.Value)
		case "Address":
			inst.Address = p.Value
		}
		inst.Params = append(inst.Params, p)
	}
	inst.Version = awgVersion(inst.Params)

	// утилиты: в новых образах awg, в легаси amnezia-wg - wg
	tool := "awg"
	if v, ok := dexec(ctx, name, "awg", "--version"); ok {
		inst.Tools = strings.TrimSpace(v)
	} else if v, ok := dexec(ctx, name, "wg", "--version"); ok {
		tool, inst.Tools = "wg", strings.TrimSpace(v)
	}
	// userspace amneziawg-go работает через tun: у такого интерфейса есть tun_flags
	if _, ok := dexec(ctx, name, "test", "-e", "/sys/class/net/"+inst.Iface+"/tun_flags"); ok {
		inst.Impl = "go"
	} else if _, ok := dexec(ctx, name, "test", "-e", "/sys/class/net/"+inst.Iface); ok {
		inst.Impl = "kernel"
	}
	if pub, ok := dexec(ctx, name, "cat", path.Join(awgDir, "wireguard_server_public_key.key")); ok {
		inst.PublicKey = strings.TrimSpace(pub)
	}

	var stats map[string]awgPeerStats
	if dump, ok := dexec(ctx, name, tool, "show", inst.Iface, "dump"); ok {
		stats = parseAwgDump(dump)
	}
	var table []awgTableEntry
	if text, ok := dexec(ctx, name, "cat", path.Join(awgDir, "clientsTable")); ok {
		inst.table = text
		var err error
		if table, err = parseClientsTable(text); err != nil {
			inst.TableError = "clientsTable не разобран: " + err.Error()
		}
	}
	inst.Clients = mergeAwgClients(peers, stats, table)
	return inst
}

// parseAwgConf разбирает конфиг сервера на параметры [Interface] и пиры (PublicKey -> AllowedIPs).
func parseAwgConf(text string) ([]AwgParam, map[string]string) {
	params := []AwgParam{}
	peers := map[string]string{}
	section, peerKey, peerIPs := "", "", ""
	flush := func() {
		if section == "peer" && peerKey != "" {
			peers[peerKey] = peerIPs
		}
		peerKey, peerIPs = "", ""
	}
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			flush()
			section = strings.ToLower(strings.Trim(line, "[] "))
			continue
		}
		commented := false
		if strings.HasPrefix(line, "#") {
			commented = true
			line = strings.TrimSpace(strings.TrimLeft(line, "#"))
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok {
			continue
		}
		k, v = strings.TrimSpace(k), strings.TrimSpace(v)
		switch section {
		case "interface":
			// из комментариев берём только I1-I5: остальное - заметки людей и панелей
			if commented && !reIParam.MatchString(k) {
				continue
			}
			params = append(params, AwgParam{Key: k, Value: v, Commented: commented})
		case "peer":
			if commented {
				continue
			}
			switch strings.ToLower(k) {
			case "publickey":
				peerKey = v
			case "allowedips":
				peerIPs = v
			}
		}
	}
	flush()
	return params, peers
}

var reIParam = regexp.MustCompile(`^I[1-5]$`)

// awgVersion определяет версию протокола по набору параметров интерфейса.
func awgVersion(params []AwgParam) string {
	has := map[string]bool{}
	rangeH := false
	for _, p := range params {
		has[p.Key] = true
		if strings.HasPrefix(p.Key, "H") && len(p.Key) == 2 && strings.Contains(p.Value, "-") {
			rangeH = true
		}
	}
	switch {
	case has["RandomTrailers"] || has["DisableCookies"]:
		return "3.1"
	case has["HeaderProtectionKey"] || has["ContentPaddingAddition"] || has["RekeyAfterTime"] ||
		has["RekeyTimeout"] || has["RejectAfterTime"] || has["KeepaliveTimeout"] || has["MaxHandshakeAttempts"]:
		return "3.0"
	case has["S3"] || has["S4"] || rangeH:
		return "2.0"
	case has["I1"] || has["I2"] || has["I3"] || has["I4"] || has["I5"]:
		return "1.5"
	case has["Jc"] || has["S1"] || has["H1"]:
		return "1.0"
	}
	return "wg"
}

type awgPeerStats struct {
	endpoint   string
	allowedIPs string
	handshake  int64
	rx, tx     int64
}

// parseAwgDump берёт строки пиров "awg show <if> dump": 8 полей через TAB во всех версиях
// (pub, psk, endpoint, allowed_ips, handshake, rx, tx, keepalive). Строка интерфейса -
// другой длины и пропускается.
func parseAwgDump(text string) map[string]awgPeerStats {
	out := map[string]awgPeerStats{}
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) != 8 {
			continue
		}
		hs, _ := strconv.ParseInt(f[4], 10, 64)
		rx, _ := strconv.ParseInt(f[5], 10, 64)
		tx, _ := strconv.ParseInt(f[6], 10, 64)
		ep := f[2]
		if ep == "(none)" {
			ep = ""
		}
		out[f[0]] = awgPeerStats{endpoint: ep, allowedIPs: f[3], handshake: hs, rx: rx, tx: tx}
	}
	return out
}

type awgTableEntry struct {
	key, name, device, created, ips string
	disabled                        bool
}

// parseClientsTable - записи clientsTable для показа (тот же разбор, что при записи - loadTable).
// Записи без clientId пропускаются. Пустой файл - пустая таблица.
func parseClientsTable(text string) ([]awgTableEntry, error) {
	table, err := loadTable(text)
	if err != nil {
		return nil, err
	}
	out := make([]awgTableEntry, 0, len(table))
	for _, e := range table {
		key, _ := e["clientId"].(string)
		if key == "" {
			continue
		}
		ud, _ := e["userData"].(map[string]any)
		str := func(k string) string { v, _ := ud[k].(string); return v }
		enabled, set := ud["enabled"].(bool)
		out = append(out, awgTableEntry{key: key, name: str("clientName"), device: str("device"),
			created: str("creationDate"), ips: tableIPs(ud), disabled: set && !enabled})
	}
	return out, nil
}

// mergeAwgClients сводит пиры конфига, статистику и clientsTable в один список по ключу.
// Порядок: как в clientsTable, затем пиры без записи ("внешние").
func mergeAwgClients(peers map[string]string, stats map[string]awgPeerStats, table []awgTableEntry) []AwgClient {
	out := []AwgClient{}
	seen := map[string]bool{}
	fill := func(c *AwgClient) {
		if ips, ok := peers[c.PublicKey]; ok {
			c.InConfig = true
			if ips != "" {
				c.AllowedIPs = ips
			}
		}
		if s, ok := stats[c.PublicKey]; ok {
			c.Endpoint, c.Handshake, c.Rx, c.Tx = s.endpoint, s.handshake, s.rx, s.tx
			if c.AllowedIPs == "" {
				c.AllowedIPs = s.allowedIPs
			}
		}
	}
	for _, t := range table {
		if seen[t.key] {
			continue
		}
		seen[t.key] = true
		c := AwgClient{PublicKey: t.key, Name: t.name, Device: t.device, Created: t.created,
			AllowedIPs: t.ips, InTable: true, Disabled: t.disabled}
		fill(&c)
		out = append(out, c)
	}
	rest := make([]string, 0, len(peers))
	for k := range peers {
		if !seen[k] {
			rest = append(rest, k)
		}
	}
	sort.Slice(rest, func(i, j int) bool { return peers[rest[i]] < peers[rest[j]] })
	for _, k := range rest {
		c := AwgClient{PublicKey: k}
		fill(&c)
		out = append(out, c)
	}
	return out
}
