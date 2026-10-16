package adapters

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Живая статистика клиентов (clients.stats): счётчики трафика и признаки подключения всех
// сервисов сервера одним ответом. Только чтение и только то, что нужно карточке клиента: без
// UUID, паролей, ключей и адресов клиентов. Панель зовёт метод раз в несколько секунд, пока
// открыта карточка, поэтому каждый источник - один дешёвый запрос со своим таймаутом.

// ClientStatsRequest - токен API 3X-UI (как у xui.api): без него VLESS не читается.
type ClientStatsRequest struct {
	XuiToken string `json:"xuiToken"`
}

// XuiClientStat - клиент 3X-UI по email: байты от клиента (up) и к клиенту (down), время
// последней активности (мс) и признак "на связи" (clients/onlines).
type XuiClientStat struct {
	Up         int64 `json:"up"`
	Down       int64 `json:"down"`
	LastOnline int64 `json:"lastOnline"`
	Online     bool  `json:"online"`
}

// AwgPeerStat - пир AWG: последний handshake (unix с), байты от клиента (rx) и к клиенту (tx).
type AwgPeerStat struct {
	Handshake int64 `json:"handshake"`
	Rx        int64 `json:"rx"`
	Tx        int64 `json:"tx"`
}

// MtUserStat - пользователь telemt по метке: байты от клиента и к клиенту с запуска telemt,
// подключений и адресов сейчас.
type MtUserStat struct {
	In    int64 `json:"in"`
	Out   int64 `json:"out"`
	Conns int64 `json:"conns"`
	IPs   int   `json:"ips"`
}

// WdttStat - пароль WDTT по ключу (16 hex sha256 пароля, сам пароль наружу не уходит).
type WdttStat struct {
	Up      int64 `json:"up"`
	Down    int64 `json:"down"`
	Devices int   `json:"devices"`
}

// OfChannelStat - канал OpenFlux: работает ли служба, с какого времени, прямых соединений.
type OfChannelStat struct {
	Active bool   `json:"active"`
	Since  string `json:"since"`
	Conns  int    `json:"conns"`
}

// ClientStats - ответ clients.stats. Раздела нет - сервиса на сервере нет (или он не ответил:
// тогда причина в Errors под тем же именем).
type ClientStats struct {
	At       int64                             `json:"at"`
	Xui      map[string]XuiClientStat          `json:"xui,omitempty"`
	Awg      map[string]map[string]AwgPeerStat `json:"awg,omitempty"`
	Mtproxyl map[string]MtUserStat             `json:"mtproxyl,omitempty"`
	Wdtt     map[string]WdttStat               `json:"wdtt,omitempty"`
	Openflux map[string]OfChannelStat          `json:"openflux,omitempty"`
	Naive    *bool                             `json:"naive,omitempty"`
	Errors   map[string]string                 `json:"errors"`
}

// statsTimeout - на каждый источник: медленный сервис не держит остальные.
const statsTimeout = 4 * time.Second

// errNotInstalled - источника на сервере нет: не ошибка, раздел просто не попадает в ответ.
var errNotInstalled = errors.New("не установлен")

// ClientStatsAll собирает все источники параллельно.
func ClientStatsAll(ctx context.Context, req ClientStatsRequest) ClientStats {
	out := ClientStats{Errors: map[string]string{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	run := func(name string, fn func(ctx context.Context) error) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, cancel := context.WithTimeout(ctx, statsTimeout)
			defer cancel()
			err := fn(c)
			if err != nil && !errors.Is(err, errNotInstalled) {
				mu.Lock()
				out.Errors[name] = err.Error()
				mu.Unlock()
			}
		}()
	}
	run("xui", func(c context.Context) error {
		m, err := xuiClientStats(c, req.XuiToken)
		mu.Lock()
		out.Xui = m
		mu.Unlock()
		return err
	})
	run("awg", func(c context.Context) error {
		m, err := awgStatsAll(c)
		mu.Lock()
		out.Awg = m
		mu.Unlock()
		return err
	})
	run("mtproxyl", func(c context.Context) error {
		m, err := mtUserStats(c)
		mu.Lock()
		out.Mtproxyl = m
		mu.Unlock()
		return err
	})
	run("wdtt", func(c context.Context) error {
		m, err := wdttStats(c)
		mu.Lock()
		out.Wdtt = m
		mu.Unlock()
		return err
	})
	run("openflux", func(c context.Context) error {
		m, err := ofChannelStats(c)
		mu.Lock()
		out.Openflux = m
		mu.Unlock()
		return err
	})
	run("naive", func(c context.Context) error {
		if _, err := os.Stat(naiveUnit); err != nil {
			return errNotInstalled
		}
		active := strings.TrimSpace(shell.Out(c, "systemctl", "is-active", "vps-naive")) == "active"
		mu.Lock()
		out.Naive = &active
		mu.Unlock()
		return nil
	})
	wg.Wait()
	out.At = time.Now().UnixMilli()
	return out
}

// ---- 3X-UI ----

// xuiBase - адрес REST API 3X-UI: ReadXui читает базу, поэтому адрес запоминается на минуту.
var xuiBase struct {
	sync.Mutex
	url string
	at  time.Time
}

func xuiAPIBase(ctx context.Context) (string, error) {
	xuiBase.Lock()
	defer xuiBase.Unlock()
	if xuiBase.url != "" && time.Since(xuiBase.at) < time.Minute {
		return xuiBase.url, nil
	}
	info, err := services.ReadXui(ctx, nil)
	if err != nil {
		return "", err
	}
	if info == nil {
		return "", errNotInstalled
	}
	scheme := "http"
	if info.HTTPS {
		scheme = "https"
	}
	host := "127.0.0.1"
	if info.PanelListen != "" && info.PanelListen != "0.0.0.0" && info.PanelListen != "::" {
		host = info.PanelListen
	}
	base := strings.TrimSuffix(info.BasePath, "/")
	xuiBase.url = fmt.Sprintf("%s://%s%s/panel/api/", scheme, net.JoinHostPort(host, strconv.Itoa(info.PanelPort)), base)
	xuiBase.at = time.Now()
	return xuiBase.url, nil
}

// xuiCall - запрос к REST 3X-UI, obj из конверта {success, msg, obj}.
func xuiCall(ctx context.Context, base, token, method, path string) (json.RawMessage, error) {
	req, err := http.NewRequestWithContext(ctx, method, base+path, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	resp, err := localTLS.Do(req)
	if err != nil {
		return nil, fmt.Errorf("панель 3X-UI не отвечает: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, errors.New("3X-UI отверг API-токен")
	}
	var env struct {
		Success bool            `json:"success"`
		Msg     string          `json:"msg"`
		Obj     json.RawMessage `json:"obj"`
	}
	if resp.StatusCode != 200 || json.Unmarshal(raw, &env) != nil || !env.Success {
		return nil, fmt.Errorf("3X-UI (%s): %d %s", path, resp.StatusCode, env.Msg)
	}
	return env.Obj, nil
}

func xuiClientStats(ctx context.Context, token string) (map[string]XuiClientStat, error) {
	base, err := xuiAPIBase(ctx)
	if err != nil {
		return nil, err
	}
	if token == "" {
		return nil, errors.New("нет API-токена 3X-UI")
	}
	list, err := xuiCall(ctx, base, token, http.MethodGet, "clients/list")
	if err != nil {
		return nil, err
	}
	out, err := parseXuiClients(list)
	if err != nil {
		return nil, err
	}
	// онлайн - отдельным запросом; в старых версиях его нет - без онлайна
	if raw, err := xuiCall(ctx, base, token, http.MethodPost, "clients/onlines"); err == nil {
		var emails []string
		if json.Unmarshal(raw, &emails) == nil {
			for _, e := range emails {
				if s, ok := out[e]; ok {
					s.Online = true
					out[e] = s
				}
			}
		}
	}
	return out, nil
}

// parseXuiClients - clients/list 3X-UI v3: email и счётчики из traffic; uuid и subId из ответа
// дальше не идут.
func parseXuiClients(raw json.RawMessage) (map[string]XuiClientStat, error) {
	var rows []struct {
		Email   string `json:"email"`
		Traffic *struct {
			Up         int64 `json:"up"`
			Down       int64 `json:"down"`
			LastOnline int64 `json:"lastOnline"`
		} `json:"traffic"`
	}
	if len(raw) == 0 || string(raw) == "null" {
		return map[string]XuiClientStat{}, nil
	}
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil, fmt.Errorf("3X-UI clients/list: %w", err)
	}
	out := make(map[string]XuiClientStat, len(rows))
	for _, r := range rows {
		if r.Email == "" {
			continue
		}
		s := XuiClientStat{}
		if r.Traffic != nil {
			s.Up, s.Down, s.LastOnline = r.Traffic.Up, r.Traffic.Down, r.Traffic.LastOnline
		}
		out[r.Email] = s
	}
	return out, nil
}

// ---- AWG ----

func awgStatsAll(ctx context.Context) (map[string]map[string]AwgPeerStat, error) {
	if !dockerapi.Available() {
		return nil, errNotInstalled
	}
	list, err := dockerapi.New().List(ctx)
	if list == nil {
		return nil, err
	}
	out := map[string]map[string]AwgPeerStat{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	var errs []string
	if err != nil {
		errs = append(errs, err.Error())
	}
	for _, c := range list {
		if !reAwgContainer.MatchString(c.Name) || c.State != "running" {
			continue
		}
		wg.Add(1)
		go func(name string) {
			defer wg.Done()
			// amneziawg-go - awg, легаси amnezia-wg - wg; один exec на контейнер
			res, err := awgDocker(ctx, statsTimeout, nil, "exec", name, "sh", "-c",
				"awg show all dump 2>/dev/null || wg show all dump")
			mu.Lock()
			defer mu.Unlock()
			if err != nil || res.ExitCode != 0 {
				errs = append(errs, name+": "+firstLine(res.Stderr, fmt.Sprint(err)))
				return
			}
			out[name] = parseAwgDumpAll(res.Stdout)
		}(c.Name)
	}
	wg.Wait()
	if len(out) == 0 && len(errs) == 0 {
		return nil, errNotInstalled
	}
	if len(errs) > 0 {
		return out, errors.New(strings.Join(errs, "; "))
	}
	return out, nil
}

// parseAwgDumpAll - строки пиров "awg show all dump": имя интерфейса и поля пира, как в
// parseAwgDump. Endpoint (адрес клиента) не берётся.
func parseAwgDumpAll(text string) map[string]AwgPeerStat {
	out := map[string]AwgPeerStat{}
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 {
			continue
		}
		if pub, s, ok := awgPeerFields(f[1:]); ok {
			out[pub] = AwgPeerStat{Handshake: s.handshake, Rx: s.rx, Tx: s.tx}
		}
	}
	return out
}

// ---- MTProxy (telemt) ----

// mtConfig - конфиг telemt, который пишет MTProxyL (переменная - для тестов).
var mtConfig = "/opt/mtproxyl/mtproxy/config.toml"

// telemtAddrs - адреса метрик Prometheus ([server] metrics_listen или metrics_port) и REST API
// ([server.api] listen, enabled, auth_header) из конфига telemt.
type telemtAddrs struct {
	metrics, api, auth string
}

var reTomlKV = regexp.MustCompile(`^\s*([A-Za-z0-9_]+)\s*=\s*(.+?)\s*$`)

func parseTelemtConfig(text string) telemtAddrs {
	var a telemtAddrs
	section := ""
	metricsPort := ""
	apiEnabled := true
	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if strings.HasPrefix(line, "[") {
			section = strings.Trim(line, "[] ")
			continue
		}
		m := reTomlKV.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		v := m[2]
		if i := strings.Index(v, " #"); i >= 0 && !strings.HasPrefix(v, `"`) {
			v = strings.TrimSpace(v[:i])
		}
		v = strings.Trim(v, `"'`)
		switch section + "." + m[1] {
		case "server.metrics_listen":
			a.metrics = v
		case "server.metrics_port":
			metricsPort = v
		case "server.api.listen":
			a.api = v
		case "server.api.enabled":
			apiEnabled = v != "false"
		case "server.api.auth_header":
			a.auth = v
		}
	}
	if a.metrics == "" && metricsPort != "" {
		a.metrics = "127.0.0.1:" + metricsPort
	}
	if !apiEnabled {
		a.api = ""
	}
	return a
}

var plainHTTP = &http.Client{Timeout: statsTimeout}

func mtUserStats(ctx context.Context) (map[string]MtUserStat, error) {
	b, err := os.ReadFile(mtConfig)
	if err != nil {
		return nil, errNotInstalled
	}
	a := parseTelemtConfig(string(b))
	if a.metrics == "" {
		return nil, errors.New("в конфиге telemt нет metrics_listen")
	}
	host := strings.Replace(a.metrics, "0.0.0.0:", "127.0.0.1:", 1)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/metrics", nil)
	if err != nil {
		return nil, err
	}
	resp, err := plainHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("метрики telemt не отвечают: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("метрики telemt: %d", resp.StatusCode)
	}
	out := parseTelemtMetrics(io.LimitReader(resp.Body, 16<<20))
	// адреса - из REST API; не ответил - без них
	if a.api != "" {
		if ips, err := telemtActiveIPs(ctx, strings.Replace(a.api, "0.0.0.0:", "127.0.0.1:", 1), a.auth); err == nil {
			for u, n := range ips {
				s := out[u]
				s.IPs = n
				out[u] = s
			}
		}
	}
	return out, nil
}

var reMetric = regexp.MustCompile(`^(telemt_user_[a-z_]+)\{([^}]*)\}\s+([0-9.eE+-]+)`)
var reUserLabel = regexp.MustCompile(`(?:^|,)user="([^"]*)"`)

// parseTelemtMetrics - счётчики по пользователю; имена с суффиксом _total (telemt 3.5+) и без.
func parseTelemtMetrics(r io.Reader) map[string]MtUserStat {
	out := map[string]MtUserStat{}
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 64<<10), 1<<20)
	for sc.Scan() {
		m := reMetric.FindStringSubmatch(sc.Text())
		if m == nil {
			continue
		}
		u := reUserLabel.FindStringSubmatch(m[2])
		if u == nil {
			continue
		}
		v, err := strconv.ParseFloat(m[3], 64)
		if err != nil {
			continue
		}
		s := out[u[1]]
		switch strings.TrimSuffix(m[1], "_total") {
		case "telemt_user_octets_from_client":
			s.In += int64(v)
		case "telemt_user_octets_to_client":
			s.Out += int64(v)
		case "telemt_user_connections_current":
			s.Conns += int64(v)
		default:
			continue
		}
		out[u[1]] = s
	}
	return out
}

// telemtActiveIPs - число адресов на пользователя (сами адреса дальше не идут).
func telemtActiveIPs(ctx context.Context, host, auth string) (map[string]int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "http://"+host+"/v1/stats/users/active-ips", nil)
	if err != nil {
		return nil, err
	}
	if auth != "" {
		req.Header.Set("Authorization", auth)
	}
	resp, err := plainHTTP.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("active-ips: %d", resp.StatusCode)
	}
	return parseTelemtActiveIPs(raw)
}

func parseTelemtActiveIPs(raw []byte) (map[string]int, error) {
	var env struct {
		Ok   bool `json:"ok"`
		Data []struct {
			Username  string            `json:"username"`
			ActiveIPs []json.RawMessage `json:"active_ips"`
		} `json:"data"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return nil, err
	}
	out := map[string]int{}
	for _, d := range env.Data {
		out[d.Username] = len(d.ActiveIPs)
	}
	return out, nil
}

// ---- WDTT ----

// WdttStatKey - ключ пароля WDTT (как wdttKey панели): 16 hex sha256.
func WdttStatKey(password string) string {
	h := sha256.Sum256([]byte(password))
	return hex.EncodeToString(h[:])[:16]
}

func wdttStats(ctx context.Context) (map[string]WdttStat, error) {
	if _, err := os.Stat(wdttUnit); err != nil {
		return nil, errNotInstalled
	}
	r, err := WdttAPI(ctx, WdttAPIRequest{Method: http.MethodGet, Path: "/admin/passwords"})
	if err != nil {
		return nil, err
	}
	raw, _ := r["data"].(json.RawMessage)
	if st, _ := r["status"].(int); st != 200 || raw == nil {
		return nil, fmt.Errorf("admin API WDTT: %v", r["status"])
	}
	return parseWdttPasswords(raw)
}

func parseWdttPasswords(raw []byte) (map[string]WdttStat, error) {
	var body struct {
		Passwords []struct {
			Password      string `json:"password"`
			DownBytes     int64  `json:"down_bytes"`
			UpBytes       int64  `json:"up_bytes"`
			ActiveDevices int    `json:"active_devices"`
		} `json:"passwords"`
	}
	if err := json.Unmarshal(raw, &body); err != nil {
		return nil, fmt.Errorf("admin API WDTT: %w", err)
	}
	out := make(map[string]WdttStat, len(body.Passwords))
	for _, p := range body.Passwords {
		if p.Password == "" {
			continue
		}
		// up_bytes - отдано клиентом (от клиента), down_bytes - скачано клиентом (к клиенту)
		out[WdttStatKey(p.Password)] = WdttStat{Up: p.UpBytes, Down: p.DownBytes, Devices: p.ActiveDevices}
	}
	return out, nil
}

// ---- OpenFlux ----

func ofChannelStats(ctx context.Context) (map[string]OfChannelStat, error) {
	chs := ofChannels()
	if len(chs) == 0 {
		return nil, errNotInstalled
	}
	ports := map[int]string{}
	args := []string{"show", "-p", "Id", "-p", "ActiveState", "-p", "ActiveEnterTimestamp"}
	for _, ch := range chs {
		b, _ := os.ReadFile(filepath.Join(ofEtcDir, ch, "port"))
		if p, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil && p > 0 {
			ports[p] = ch
		}
		args = append(args, "openflux-node@"+ch+".service")
	}
	out := parseOfShow(shell.Out(ctx, "systemctl", args...))
	for _, ch := range chs {
		if _, ok := out[ch]; !ok {
			out[ch] = OfChannelStat{}
		}
	}
	for port, n := range countEstablished(shell.Out(ctx, "ss", "-Htn", "state", "established")) {
		if ch, ok := ports[port]; ok {
			s := out[ch]
			s.Conns = n
			out[ch] = s
		}
	}
	return out, nil
}

// parseOfShow - блоки "systemctl show" нескольких служб (Id, ActiveState, ActiveEnterTimestamp),
// разделённые пустой строкой.
func parseOfShow(text string) map[string]OfChannelStat {
	out := map[string]OfChannelStat{}
	var id string
	var cur OfChannelStat
	flush := func() {
		if ch, ok := strings.CutPrefix(id, "openflux-node@"); ok {
			out[strings.TrimSuffix(ch, ".service")] = cur
		}
		id, cur = "", OfChannelStat{}
	}
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			flush()
			continue
		}
		k, v, _ := strings.Cut(line, "=")
		switch k {
		case "Id":
			id = v
		case "ActiveState":
			cur.Active = v == "active"
		case "ActiveEnterTimestamp":
			if t, err := time.Parse("Mon 2006-01-02 15:04:05 MST", v); err == nil {
				cur.Since = t.UTC().Format(time.RFC3339)
			}
		}
	}
	flush()
	for ch, s := range out {
		if !s.Active {
			s.Since = ""
			out[ch] = s
		}
	}
	return out
}

// countEstablished - установленные TCP по локальному порту из "ss -Htn state established"
// (Recv-Q Send-Q Local:Port Peer:Port).
func countEstablished(text string) map[int]int {
	out := map[int]int{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		local := f[2]
		i := strings.LastIndex(local, ":")
		if i < 0 {
			continue
		}
		if p, err := strconv.Atoi(local[i+1:]); err == nil {
			out[p]++
		}
	}
	return out
}
