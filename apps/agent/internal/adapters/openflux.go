package adapters

import (
	"bufio"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/cookiejar"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// OpenFlux: каналы выходной ноды ставит node-install.sh - мастер "Своя
// нода" приложений OpenFlux или панель. Канал - /etc/openflux-node/<канал>/ (node.conf,
// encryption-key, port), служба openflux-node@<канал>. Ключ и адреса документов - секреты:
// наружу уходят только в ссылке для приложения (по запросу администратора) и в журнал не пишутся.

// ofEtcDir - каталог каналов (переменная - для тестов).
var ofEtcDir = "/etc/openflux-node"

const (
	ofBin       = "/opt/openflux-node/bin/openflux"
	ofInstaller = "/opt/openflux-node/node-install.sh"
	// установщик для сервера, где OpenFlux ещё нет: та же версия, что ставят приложения
	// (sha256 сверен с серверами); при смене - обновить обе строки
	ofInstallerURL    = "https://raw.githubusercontent.com/p1neappleXpress/OpenFlux/ba31d0fc38b9b227231056a5ef845f7eae08f42c/deploy/node-install.sh"
	ofInstallerSHA256 = "90fd4532ac960fa2c508d55f978baf64871f15128a9531f71144e6f063d9c858"
)

var (
	reOfChannel = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,30}$`)
	reOfSection = regexp.MustCompile(`^\[Transport\s+"?([^"\]]+)"?\]$`)
	reOfKV      = regexp.MustCompile(`^(\w+)\s*=\s*(.*)$`)
	reOfURL     = regexp.MustCompile(`https?://[^\s"']+`)
	reOfHex     = regexp.MustCompile(`\b[0-9a-f]{64}\b`)
)

// OfTransport - транспорт канала: тип и приоритет; адрес (url) - только для ссылки.
type OfTransport struct {
	Name     string `json:"name"`
	Type     string `json:"type"`
	Priority int    `json:"priority"`
	url      string
	listen   string
}

// OfChannel - канал для вкладки: без секретов.
type OfChannel struct {
	Channel    string        `json:"channel"`
	Port       int           `json:"port"`
	State      string        `json:"state"`
	Enabled    bool          `json:"enabled"`
	Since      string        `json:"since"`
	MemoryMb   float64       `json:"memoryMb"`
	Transports []OfTransport `json:"transports"`
}

// OfStatusResult - вкладка OpenFlux.
type OfStatusResult struct {
	Installed  bool        `json:"installed"`
	Core       string      `json:"core"`
	Autoupdate bool        `json:"autoupdate"`
	Channels   []OfChannel `json:"channels"`
}

type ofConf struct {
	context    string
	transports []OfTransport
}

// readOfConf - node.conf канала (формат node-install.sh: [Interface]-ключи вверху, затем
// [Transport имя] с Type, Priority, URL, Listen).
func readOfConf(channel string) (ofConf, error) {
	f, err := os.Open(filepath.Join(ofEtcDir, channel, "node.conf"))
	if err != nil {
		return ofConf{}, err
	}
	defer f.Close()
	var c ofConf
	var cur *OfTransport
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if m := reOfSection.FindStringSubmatch(line); m != nil {
			c.transports = append(c.transports, OfTransport{Name: m[1], Type: m[1], Priority: 50})
			cur = &c.transports[len(c.transports)-1]
			continue
		}
		m := reOfKV.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		key, val := strings.ToLower(m[1]), strings.TrimSpace(m[2])
		if cur == nil {
			if key == "url" {
				c.context = val
			}
			continue
		}
		switch key {
		case "type":
			cur.Type = val
		case "priority":
			cur.Priority, _ = strconv.Atoi(val)
		case "url":
			cur.url = val
		case "listen":
			cur.listen = val
		}
	}
	return c, sc.Err()
}

func ofChannels() []string {
	ports, _ := filepath.Glob(filepath.Join(ofEtcDir, "*", "port"))
	var out []string
	for _, p := range ports {
		if ch := filepath.Base(filepath.Dir(p)); reOfChannel.MatchString(ch) {
			out = append(out, ch)
		}
	}
	return out
}

func ofChannelExists(ch string) error {
	if !reOfChannel.MatchString(ch) {
		return errors.New("имя канала: только a-z, 0-9 и дефис, до 31 символа")
	}
	if _, err := os.Stat(filepath.Join(ofEtcDir, ch, "node.conf")); err != nil {
		return fmt.Errorf("канала %s нет на сервере", ch)
	}
	return nil
}

// OfStatus - каналы, ядро, автообновление.
func OfStatus(ctx context.Context) OfStatusResult {
	res := OfStatusResult{Channels: []OfChannel{}}
	res.Installed = ofInstalled()
	if t, err := os.Readlink(ofBin); err == nil {
		res.Core = strings.TrimPrefix(filepath.Base(t), "openflux-node-v")
	}
	res.Autoupdate = strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", "openflux-node-update.timer")) == "active"
	for _, ch := range ofChannels() {
		c := OfChannel{Channel: ch, Transports: []OfTransport{}}
		b, _ := os.ReadFile(filepath.Join(ofEtcDir, ch, "port"))
		c.Port, _ = strconv.Atoi(strings.TrimSpace(string(b)))
		unit := "openflux-node@" + ch
		c.State = strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", unit))
		c.Enabled = strings.TrimSpace(shell.Out(ctx, "systemctl", "is-enabled", unit)) == "enabled"
		for _, line := range strings.Split(shell.Out(ctx, "systemctl", "show", "-p", "ActiveEnterTimestamp", "-p", "MemoryCurrent", unit), "\n") {
			k, v, _ := strings.Cut(line, "=")
			switch k {
			case "ActiveEnterTimestamp":
				if t, err := time.Parse("Mon 2006-01-02 15:04:05 MST", v); err == nil && c.State == "active" {
					c.Since = t.UTC().Format(time.RFC3339)
				}
			case "MemoryCurrent":
				if n, err := strconv.ParseFloat(v, 64); err == nil {
					c.MemoryMb = float64(int(n/1024/1024*10)) / 10
				}
			}
		}
		if conf, err := readOfConf(ch); err == nil {
			c.Transports = append(c.Transports, conf.transports...)
		}
		res.Channels = append(res.Channels, c)
	}
	return res
}

// MaskOfLog - ссылки на документы и ключи в журнале: адрес - только хост, 64 hex - звёздочки.
func MaskOfLog(s string) string {
	s = reOfURL.ReplaceAllStringFunc(s, func(u string) string {
		scheme, rest, _ := strings.Cut(u, "://")
		host, _, _ := strings.Cut(rest, "/")
		return scheme + "://" + host + "/***"
	})
	return reOfHex.ReplaceAllString(s, "***")
}

// OfLogs - последние строки журнала канала.
func OfLogs(ctx context.Context, ch string, lines int) (map[string]any, error) {
	if err := ofChannelExists(ch); err != nil {
		return nil, err
	}
	if lines <= 0 || lines > 2000 {
		lines = 200
	}
	out := shell.Out(ctx, "journalctl", "-u", "openflux-node@"+ch, "-n", strconv.Itoa(lines), "--no-pager", "-o", "short-iso")
	return map[string]any{"text": MaskOfLog(out)}, nil
}

// OfLinkRequest - ссылка для приложения: name - подпись профиля, host - адрес для direct.
type OfLinkRequest struct {
	Channel string `json:"channel"`
	Name    string `json:"name"`
	Host    string `json:"host"`
}

type ofShareTransport struct {
	Type     string `json:"type"`
	Name     string `json:"name,omitempty"`
	URL      string `json:"url,omitempty"`
	Priority int    `json:"priority,omitempty"`
	Dial     string `json:"dial,omitempty"`
}

// OfLink - openflux://-ссылка канала тем же ядром, что работает на сервере (--make-link).
func OfLink(ctx context.Context, req OfLinkRequest) (map[string]any, error) {
	if err := ofChannelExists(req.Channel); err != nil {
		return nil, err
	}
	// адрес для direct: IP или имя (адрес для клиентов) - ядро OpenFlux у клиента само
	// разрешает имя, в обход своего туннеля
	if net.ParseIP(req.Host) == nil && !reNaiveHost.MatchString(strings.ToLower(req.Host)) {
		return nil, errors.New("нужен адрес сервера для direct: IP или имя")
	}
	conf, err := readOfConf(req.Channel)
	if err != nil {
		return nil, err
	}
	key, err := os.ReadFile(filepath.Join(ofEtcDir, req.Channel, "encryption-key"))
	if err != nil {
		return nil, err
	}
	ts := []ofShareTransport{}
	for _, t := range conf.transports {
		st := ofShareTransport{Type: t.Type, Priority: t.Priority, URL: t.url}
		if t.Name != t.Type {
			st.Name = t.Name
		}
		if t.Type == "direct" {
			_, port, err := net.SplitHostPort(t.listen)
			if err != nil {
				continue
			}
			st.URL, st.Dial = "", net.JoinHostPort(req.Host, port)
		}
		ts = append(ts, st)
	}
	cfg := map[string]any{
		"name": strings.TrimSpace(req.Name), "negotiate": true,
		"secret": strings.TrimSpace(string(key)), "context": conf.context, "transports": ts,
	}
	b, _ := json.Marshal(cfg)
	res, err := shell.ExecInput(ctx, 30*time.Second, string(b), ofBin, "--make-link", "-")
	if err != nil {
		return nil, err
	}
	var out struct {
		Link  string `json:"link"`
		Error string `json:"error"`
	}
	if json.Unmarshal([]byte(strings.TrimSpace(res.Stdout)), &out) != nil || out.Link == "" {
		if out.Error == "" {
			out.Error = firstLine(res.Stderr, res.Stdout)
		}
		return nil, errors.New("ссылка не собрана: " + MaskOfLog(out.Error))
	}
	return map[string]any{"link": out.Link}, nil
}

// OfRequest - действия над OpenFlux.
type OfRequest struct {
	Op         string `json:"op"`
	Channel    string `json:"channel"`
	Vyandex    string `json:"vyandex"`
	Mailru     string `json:"mailru"`
	Cupsonline string `json:"cupsonline"`
}

// OfExec: rooms - новые комнаты cups.online; configure - транспорты канала заново (ключ, порт
// и куки остаются); restart, stop, start - служба канала; disable, enable - выключить с автозапуском и
// включить обратно (выключенный клиент панели); remove - удалить канал (последний канал
// установщик удаляет вместе со всем OpenFlux); autoupdate-on/off; update - ядро сейчас;
// create - новый канал.
func OfExec(ctx context.Context, req OfRequest, stream func(channel, chunk string)) (map[string]any, error) {
	log := func(s string) {
		if stream != nil {
			stream("log", s+"\n")
		}
	}
	switch req.Op {
	case "restart", "stop", "start":
		if err := ofChannelExists(req.Channel); err != nil {
			return nil, err
		}
		unit := "openflux-node@" + req.Channel
		log("$ systemctl " + req.Op + " " + unit)
		res, err := shell.Exec(ctx, time.Minute, stream, "systemctl", req.Op, unit)
		if err != nil {
			return nil, err
		}
		if res.ExitCode != 0 {
			return nil, fmt.Errorf("systemctl %s: %s", req.Op, firstLine(res.Stderr, res.Stdout))
		}
		return map[string]any{"state": strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", unit))}, nil
	case "disable", "enable":
		if err := ofChannelExists(req.Channel); err != nil {
			return nil, err
		}
		unit := "openflux-node@" + req.Channel
		log("$ systemctl " + req.Op + " --now " + unit)
		res, err := shell.Exec(ctx, time.Minute, stream, "systemctl", req.Op, "--now", unit)
		if err != nil {
			return nil, err
		}
		if res.ExitCode != 0 {
			return nil, fmt.Errorf("systemctl %s: %s", req.Op, firstLine(res.Stderr, res.Stdout))
		}
		return map[string]any{"state": strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", unit))}, nil
	case "remove":
		if err := ofChannelExists(req.Channel); err != nil {
			return nil, err
		}
		return ofInstallerRun(ctx, log, stream, 3*time.Minute, "remove", req.Channel)
	case "autoupdate-on", "autoupdate-off":
		return ofInstallerRun(ctx, log, stream, 2*time.Minute, "autoupdate", strings.TrimPrefix(req.Op, "autoupdate-"))
	case "update":
		return ofInstallerRun(ctx, log, stream, 10*time.Minute, "update")
	case "create":
		return ofCreate(ctx, req, log, stream)
	case "rooms":
		rooms, err := ofRooms(ctx, log)
		if err != nil {
			return nil, err
		}
		return map[string]any{"rooms": rooms}, nil
	case "configure":
		return ofConfigure(ctx, req, log)
	}
	return nil, errors.New("неизвестная операция: " + req.Op)
}

// ofInstallerRun - node-install.sh с аргументами (без оболочки); ответ - JSON-строка установщика.
func ofInstallerRun(ctx context.Context, log func(string), stream func(string, string), timeout time.Duration, args ...string) (map[string]any, error) {
	if err := ofEnsureInstaller(ctx, log); err != nil {
		return nil, err
	}
	return ofScript(ctx, ofInstaller, log, stream, timeout, args...)
}

func ofScript(ctx context.Context, script string, log func(string), stream func(string, string), timeout time.Duration, args ...string) (map[string]any, error) {
	log("$ node-install.sh " + strings.Join(args, " "))
	// поток - через маскировку: установщик может напечатать адрес документа
	masked := func(ch, chunk string) {
		if stream != nil {
			stream(ch, MaskOfLog(chunk))
		}
	}
	res, err := shell.Exec(ctx, timeout, masked, "sh", append([]string{script}, args...)...)
	if err != nil {
		return nil, err
	}
	var out map[string]any
	for _, line := range strings.Split(res.Stdout, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, "{") && json.Unmarshal([]byte(line), &out) == nil {
			break
		}
	}
	if res.ExitCode != 0 || out == nil || out["ok"] != true {
		msg := firstLine(res.Stderr, res.Stdout)
		if out != nil {
			if e, ok := out["error"].(string); ok && e != "" {
				msg = e
			}
		}
		return nil, errors.New("node-install.sh: " + MaskOfLog(msg))
	}
	return out, nil
}

var (
	// как valid_url и valid_mailru в node-install.sh
	reOfYandex = regexp.MustCompile(`^https://(docs|disk)\.yandex\.(ru|com|by|kz|uz)/edit/d/[A-Za-z0-9_-]{16,200}$`)
	reOfMailru = regexp.MustCompile(`^https://cloud\.mail\.ru/public/[A-Za-z0-9_-]{2,64}/[A-Za-z0-9_-]{2,128}$`)
	reOfRooms  = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
)

func ofCreate(ctx context.Context, req OfRequest, log func(string), stream func(string, string)) (map[string]any, error) {
	ch := req.Channel
	if ch == "" {
		ch = "of-" + randAlnum(6)
	}
	if !reOfChannel.MatchString(ch) {
		return nil, errors.New("имя канала: только a-z, 0-9 и дефис, до 31 символа")
	}
	if _, err := os.Stat(filepath.Join(ofEtcDir, ch)); err == nil {
		return nil, fmt.Errorf("канал %s уже есть на сервере", ch)
	}
	if err := ofCheckTransports(req, false); err != nil {
		return nil, err
	}
	if req.Cupsonline == "auto" {
		rooms, err := ofRooms(ctx, log)
		if err != nil {
			// канал важнее комнат: без них он работает напрямую и через документы
			log("cups.online: " + err.Error() + " - канал без cups.online")
			rooms = ""
		}
		req.Cupsonline = rooms
	}
	script, cleanup, err := ofInstallerPath(ctx, log)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	port, err := ofFreePort()
	if err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		return nil, err
	}
	lines := []string{"channel=" + ch, "key=" + hex.EncodeToString(key), "port=" + strconv.Itoa(port)}
	for k, v := range map[string]string{"vyandex": req.Vyandex, "mailru": req.Mailru, "cupsonline": req.Cupsonline} {
		if v != "" {
			lines = append(lines, k+"="+v)
		}
	}
	// конфиг - файлом 0600 (установщик сам удаляет его после чтения): ключ не в аргументах
	f, err := os.CreateTemp("/root", "openflux-channel-*.conf")
	if err != nil {
		return nil, err
	}
	_ = f.Chmod(0o600)
	_, werr := f.WriteString(strings.Join(lines, "\n") + "\n")
	_ = f.Close()
	defer os.Remove(f.Name())
	if werr != nil {
		return nil, werr
	}
	log(fmt.Sprintf("канал %s, порт %d/tcp", ch, port))
	out, err := ofScript(ctx, script, log, stream, 10*time.Minute, "apply", f.Name())
	if err != nil {
		return nil, err
	}
	return map[string]any{"channel": ch, "port": port, "core": out["core"], "cupsonline": req.Cupsonline != ""}, nil
}

// ofDownloadInstaller - node-install.sh закреплённой версии с GitHub со сверкой sha256.
func ofDownloadInstaller(ctx context.Context) ([]byte, error) {
	c, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	rq, _ := http.NewRequestWithContext(c, http.MethodGet, ofInstallerURL, nil)
	resp, err := http.DefaultClient.Do(rq)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("установщик: GitHub ответил %d", resp.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(b)
	if hex.EncodeToString(sum[:]) != ofInstallerSHA256 {
		return nil, errors.New("установщик: sha256 не совпал, файл подменён или версия сменилась")
	}
	return b, nil
}

// ofInstalled - OpenFlux на сервере есть: установщик, ядро или каналы.
func ofInstalled() bool {
	if _, err := os.Stat(ofInstaller); err == nil {
		return true
	}
	if _, err := os.Lstat(ofBin); err == nil {
		return true
	}
	entries, _ := os.ReadDir(ofEtcDir)
	for _, e := range entries {
		if e.IsDir() {
			return true
		}
	}
	return false
}

// ofEnsureInstaller - установщик на месте. OpenFlux, поставленный не им напрямую (мастер
// приложения без копии установщика, старая версия), его не имеет - тогда кладём ту же
// закреплённую версию в /opt/openflux-node: им работают обновление ядра и автообновление.
func ofEnsureInstaller(ctx context.Context, log func(string)) error {
	if _, err := os.Stat(ofInstaller); err == nil {
		return nil
	}
	if !ofInstalled() {
		return errors.New("OpenFlux не установлен: нет " + ofInstaller)
	}
	log("нет " + ofInstaller + ": скачиваю установщик (закреплённая версия, проверка sha256)")
	b, err := ofDownloadInstaller(ctx)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(ofInstaller), 0o755); err != nil {
		return err
	}
	tmp := ofInstaller + ".new"
	if err := os.WriteFile(tmp, b, 0o755); err != nil {
		return err
	}
	return os.Rename(tmp, ofInstaller)
}

// ofInstallerPath - установленный node-install.sh или скачанный той же версии с проверкой
// sha256 (сервер без OpenFlux); второй - во временный файл, который потом удаляется.
func ofInstallerPath(ctx context.Context, log func(string)) (string, func(), error) {
	if _, err := os.Stat(ofInstaller); err == nil {
		return ofInstaller, func() {}, nil
	}
	log("OpenFlux на сервере нет: скачиваю node-install.sh (проверка sha256)")
	b, err := ofDownloadInstaller(ctx)
	if err != nil {
		return "", nil, err
	}
	f, err := os.CreateTemp("/root", "node-install-*.sh")
	if err != nil {
		return "", nil, err
	}
	_, werr := f.Write(b)
	_ = f.Close()
	if werr != nil {
		os.Remove(f.Name())
		return "", nil, werr
	}
	return f.Name(), func() { os.Remove(f.Name()) }, nil
}

// ofFreePort - свободный TCP-порт 20000-60999, которого нет у других каналов.
func ofFreePort() (int, error) {
	claimed := map[int]bool{}
	for _, ch := range ofChannels() {
		b, _ := os.ReadFile(filepath.Join(ofEtcDir, ch, "port"))
		if n, err := strconv.Atoi(strings.TrimSpace(string(b))); err == nil {
			claimed[n] = true
		}
	}
	for i := 0; i < 50; i++ {
		var b [2]byte
		_, _ = rand.Read(b[:])
		p := 20000 + (int(b[0])<<8|int(b[1]))%41000
		if claimed[p] {
			continue
		}
		l, err := net.Listen("tcp", ":"+strconv.Itoa(p))
		if err != nil {
			continue
		}
		_ = l.Close()
		return p, nil
	}
	return 0, errors.New("нет свободного порта")
}

func randAlnum(n int) string {
	const abc = "abcdefghijklmnopqrstuvwxyz0123456789"
	b := make([]byte, n)
	_, _ = rand.Read(b)
	for i := range b {
		b[i] = abc[int(b[i])%len(abc)]
	}
	return string(b)
}

// ofCheckTransports - ссылки на документы и комнаты, как их проверяет node-install.sh; значения
// идут в файл построчно, поэтому перевод строки отсекает уже регулярка. cups.online: "auto" -
// создать комнаты, "keep" (только configure) - оставить нынешние.
func ofCheckTransports(req OfRequest, configure bool) error {
	if req.Vyandex != "" && !reOfYandex.MatchString(req.Vyandex) {
		return errors.New("Яндекс Документ: ссылка вида https://docs.yandex.ru/edit/d/...")
	}
	if req.Mailru != "" && !reOfMailru.MatchString(req.Mailru) {
		return errors.New("Mail.ru Документ: публичная ссылка вида https://cloud.mail.ru/public/.../...")
	}
	switch c := req.Cupsonline; {
	case c == "" || c == "auto" || (c == "keep" && configure):
	case len(c) < 8 || len(c) > 4096 || !reOfRooms.MatchString(c):
		return errors.New("cups.online: список комнат (буквы, цифры, - и _)")
	}
	return nil
}

// Комнаты cups.online: страница live-coding без cookies создаёт новую комнату, её uuid - в
// атрибуте data-room. Так их создаёт и ядро OpenFlux (transport/cupsonline, CreateRoomList: 4
// комнаты, пауза между ними); в сборке ноды этой функции нет, поэтому - здесь.
const (
	ofCupsURL   = "https://interview.cups.online/live-coding/"
	ofCupsUA    = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
	ofCupsRooms = 4
)

var reOfCupsRoom = regexp.MustCompile(`data-room="\{&quot;uuid&quot;:\s*&quot;([0-9a-f-]{36})&quot;`)

func ofRooms(ctx context.Context, log func(string)) (string, error) {
	var ids []string
	var lastErr error
	limited := func(err error) bool {
		return strings.Contains(err.Error(), "403") || strings.Contains(err.Error(), "429")
	}
	for i := 0; i < ofCupsRooms; i++ {
		var id string
		var err error
		for attempt := 0; attempt < 3; attempt++ {
			id, err = ofCupsRoom(ctx)
			// ограничение частоты - сразу: повторы его только продлевают
			if err == nil || limited(err) {
				break
			}
			select {
			case <-ctx.Done():
				return "", ctx.Err()
			case <-time.After(time.Duration(1<<attempt) * time.Second):
			}
		}
		if err != nil {
			// комната не далась - остальные тоже не дадутся: канал без них (или с теми, что есть),
			// а не минуты повторов на каждый канал
			lastErr = err
			break
		}
		ids = append(ids, id)
		time.Sleep(700 * time.Millisecond)
	}
	if len(ids) == 0 {
		if lastErr != nil && limited(lastErr) {
			return "", errors.New("cups.online временно не даёт новых комнат этому адресу (ограничение частоты)")
		}
		return "", fmt.Errorf("комнаты cups.online не созданы: %v", lastErr)
	}
	log(fmt.Sprintf("cups.online: комнат %d", len(ids)))
	raw, _ := json.Marshal(ids)
	return base64.RawURLEncoding.EncodeToString(raw), nil
}

func ofCupsRoom(ctx context.Context) (string, error) {
	c, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	jar, _ := cookiejar.New(nil)
	cl := &http.Client{Jar: jar}
	rq, _ := http.NewRequestWithContext(c, http.MethodGet, ofCupsURL, nil)
	rq.Header.Set("User-Agent", ofCupsUA)
	rq.Header.Set("Accept", "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")
	rq.Header.Set("Accept-Language", "ru-RU,ru;q=0.9")
	resp, err := cl.Do(rq)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("cups.online ответил %d", resp.StatusCode)
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	m := reOfCupsRoom.FindSubmatch(b)
	if m == nil {
		return "", errors.New("в ответе cups.online нет комнаты")
	}
	return string(m[1]), nil
}

// ofNodeConf - node.conf в том же виде, что пишет node-install.sh (write_node_conf): контекст
// шифрования - ссылка самого приоритетного документа, транспорты по приоритету, direct всегда.
func ofNodeConf(ch string, port int, vyandex, mailru, cups string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# OpenFlux node channel %s, written by node-install.sh\nRole = exit\nMode = l4\n", ch)
	fmt.Fprintf(&b, "EncryptionKeyFile = %s/%s/encryption-key\nCookieStore = /var/lib/openflux-node/%s/cookies.json\n", ofEtcDir, ch, ch)
	if vyandex != "" {
		fmt.Fprintf(&b, "URL = %s\n", vyandex)
	} else if mailru != "" {
		fmt.Fprintf(&b, "URL = %s\n", mailru)
	}
	if vyandex != "" {
		fmt.Fprintf(&b, "\n[Transport vyandex]\nType = vyandex\nPriority = 100\nURL = %s\n", vyandex)
	}
	if mailru != "" {
		fmt.Fprintf(&b, "\n[Transport mailru]\nType = mailru\nPriority = 90\nURL = %s\n", mailru)
	}
	if cups != "" {
		fmt.Fprintf(&b, "\n[Transport cupsonline]\nType = cupsonline\nPriority = 70\nURL = %s\n", cups)
	}
	fmt.Fprintf(&b, "\n[Transport direct]\nType = direct\nPriority = 50\nListen = 0.0.0.0:%d\n", port)
	return b.String()
}

// ofConfigure - транспорты канала заново: node.conf переписывается (права и владелец - как
// у установщика), служба перезапускается, если работала. Ключ, порт и куки не меняются, но
// с документом меняется контекст шифрования - профиль в приложении нужен новый (ссылка).
func ofConfigure(ctx context.Context, req OfRequest, log func(string)) (map[string]any, error) {
	if err := ofChannelExists(req.Channel); err != nil {
		return nil, err
	}
	if err := ofCheckTransports(req, true); err != nil {
		return nil, err
	}
	dir := filepath.Join(ofEtcDir, req.Channel)
	b, _ := os.ReadFile(filepath.Join(dir, "port"))
	port, err := strconv.Atoi(strings.TrimSpace(string(b)))
	if err != nil || port <= 0 {
		return nil, errors.New("у канала нет порта")
	}
	cups := req.Cupsonline
	switch cups {
	case "keep":
		cups = ""
		if conf, err := readOfConf(req.Channel); err == nil {
			for _, t := range conf.transports {
				if t.Type == "cupsonline" {
					cups = t.url
				}
			}
		}
	case "auto":
		rooms, err := ofRooms(ctx, log)
		if err != nil {
			return nil, err
		}
		cups = rooms
	}
	path := filepath.Join(dir, "node.conf")
	st, err := os.Stat(path)
	if err != nil {
		return nil, err
	}
	tmp := path + ".vps-new"
	if err := os.WriteFile(tmp, []byte(ofNodeConf(req.Channel, port, req.Vyandex, req.Mailru, cups)), st.Mode().Perm()); err != nil {
		return nil, err
	}
	if sys, ok := st.Sys().(*syscall.Stat_t); ok {
		_ = os.Chown(tmp, int(sys.Uid), int(sys.Gid))
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return nil, err
	}
	unit := "openflux-node@" + req.Channel
	log("node.conf канала " + req.Channel + " обновлён, перезапуск службы (если работала)")
	_ = shell.OK(ctx, "systemctl", "try-restart", unit)
	return map[string]any{"channel": req.Channel, "cupsonline": cups != ""}, nil
}
