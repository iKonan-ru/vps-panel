package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	neturl "net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

const (
	xuiBin    = "/usr/local/x-ui/x-ui"
	xuiScript = "x-ui" // /usr/bin/x-ui - скрипт управления службой
)

// XuiInfo - состояние 3x-ui для вкладки: служба, настройки панели, лог.
type XuiInfo struct {
	Installed  bool     `json:"installed"`
	Active     bool     `json:"active"`
	Enabled    bool     `json:"enabled"`
	Version    string   `json:"version"`
	DB         string   `json:"db"` // sqlite путь или "postgres"
	PanelPort  int      `json:"panelPort"`
	Listen     string   `json:"listen"`
	BasePath   string   `json:"basePath"`
	HTTPS      bool     `json:"https"`
	CertFile   string   `json:"certFile"`
	TwoFactor  bool     `json:"twoFactor"`
	SubEnabled bool     `json:"subEnabled"`
	SubPort    int      `json:"subPort"`
	Inbounds   int      `json:"inbounds"`
	Log        string   `json:"log"`
	Errors     []string `json:"errors"`
}

func XuiInfoGet(ctx context.Context) XuiInfo {
	out := XuiInfo{Errors: []string{}}
	if _, err := os.Stat(xuiBin); err != nil {
		return out
	}
	out.Installed = true
	out.Active = shell.Out(ctx, "systemctl", "is-active", "x-ui") == "active"
	out.Enabled = shell.Out(ctx, "systemctl", "is-enabled", "x-ui") == "enabled"
	out.Version = strings.TrimSpace(strings.Split(shell.Out(ctx, xuiBin, "-v"), "\n")[0])
	if info, err := services.ReadXui(ctx, nil); err != nil {
		out.Errors = append(out.Errors, err.Error())
	} else if info != nil {
		out.DB, out.PanelPort, out.Listen, out.BasePath = info.DB, info.PanelPort, info.PanelListen, info.BasePath
		out.HTTPS, out.CertFile, out.TwoFactor = info.HTTPS, info.CertFile, info.TwoFactor
		out.SubEnabled, out.SubPort, out.Inbounds = info.SubEnabled, info.SubPort, len(info.Inbounds)
	}
	out.Log = stripAnsi(shell.Out(ctx, "journalctl", "-u", "x-ui", "-n", "80", "--no-pager", "-o", "cat"))
	return out
}

// XuiSet - изменение настроек панели через x-ui setting; пустые поля не трогаются.
type XuiSet struct {
	Port           int    `json:"port"`
	Username       string `json:"username"`
	Password       string `json:"password"`
	BasePath       string `json:"basePath"`
	Listen         string `json:"listen"`
	ResetTwoFactor bool   `json:"resetTwoFactor"`
}

var (
	reXuiUser = regexp.MustCompile(`^[A-Za-z0-9_.@-]{2,64}$`)
	reXuiPath = regexp.MustCompile(`^[A-Za-z0-9_-]{0,64}$`)
)

func XuiApply(ctx context.Context, p XuiSet, stream func(channel, chunk string)) (map[string]any, error) {
	args := []string{"setting"}
	if p.Port != 0 {
		if p.Port < 1 || p.Port > 65535 {
			return nil, errors.New("порт: 1-65535")
		}
		args = append(args, "-port", strconv.Itoa(p.Port))
	}
	if p.Username != "" {
		if !reXuiUser.MatchString(p.Username) {
			return nil, errors.New("логин: буквы, цифры, _ . @ -")
		}
		args = append(args, "-username", p.Username)
	}
	if p.Password != "" {
		if len(p.Password) < 6 || strings.ContainsAny(p.Password, " \t\n") {
			return nil, errors.New("пароль: от 6 символов, без пробелов")
		}
		args = append(args, "-password", p.Password)
	}
	if p.BasePath != "" {
		bp := strings.Trim(p.BasePath, "/")
		if !reXuiPath.MatchString(bp) {
			return nil, errors.New("путь панели: буквы, цифры, _ и -")
		}
		args = append(args, "-webBasePath", "/"+bp+"/")
	}
	if p.Listen != "" {
		if p.Listen != "0.0.0.0" && net.ParseIP(p.Listen) == nil {
			return nil, errors.New("listen: IP-адрес")
		}
		args = append(args, "-listenIP", p.Listen)
	}
	if p.ResetTwoFactor {
		args = append(args, "-resetTwoFactor")
	}
	if len(args) == 1 {
		return nil, errors.New("нечего менять")
	}
	log := func(s string) {
		if stream != nil {
			stream("log", s+"\n")
		}
	}
	shown := make([]string, len(args))
	copy(shown, args)
	for i := range shown {
		if i > 0 && shown[i-1] == "-password" {
			shown[i] = "********"
		}
	}
	log("$ x-ui " + strings.Join(shown, " "))
	res, err := shell.Exec(ctx, 2*time.Minute, stream, xuiBin, args...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("x-ui setting завершился с кодом %d: %s", res.ExitCode, firstLine(res.Stderr, res.Stdout))
	}
	log("$ x-ui restart")
	r2, err := shell.Exec(ctx, 2*time.Minute, stream, xuiScript, "restart")
	if err != nil {
		return nil, err
	}
	if r2.ExitCode != 0 {
		return nil, fmt.Errorf("x-ui restart завершился с кодом %d", r2.ExitCode)
	}
	return map[string]any{"ok": true}, nil
}

var xuiServiceActions = map[string]bool{"start": true, "stop": true, "restart": true, "enable": true, "disable": true, "restart-xray": true}

// XuiService - start/stop/restart/enable/disable/restart-xray через скрипт x-ui.
func XuiService(ctx context.Context, action string, stream func(channel, chunk string)) (map[string]any, error) {
	if !xuiServiceActions[action] {
		return nil, errors.New("неизвестное действие: " + action)
	}
	res, err := shell.Exec(ctx, 3*time.Minute, stream, xuiScript, action)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("x-ui %s завершился с кодом %d: %s", action, res.ExitCode, firstLine(res.Stderr, res.Stdout))
	}
	return map[string]any{"ok": true}, nil
}

// XuiUpdate - то, что делает "x-ui update" без его меню: скрипт update.sh из репозитория
// (после обновления x-ui зовёт интерактивное меню и ругается на пустой ввод).
func XuiUpdate(ctx context.Context, stream func(channel, chunk string)) (map[string]any, error) {
	res, err := shell.Run(ctx, "f=$(mktemp) && curl -fsSL --retry 3 https://raw.githubusercontent.com/MHSanaei/3x-ui/main/update.sh -o \"$f\" && bash \"$f\" </dev/null; rc=$?; rm -f \"$f\"; exit $rc", 15*time.Minute, stream)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("x-ui update завершился с кодом %d", res.ExitCode)
	}
	return map[string]any{"ok": true, "version": strings.TrimSpace(shell.Out(ctx, xuiBin, "-v"))}, nil
}

var reApiToken = regexp.MustCompile(`(?m)^apiToken:\s*(\S+)`)

// XuiToken выпускает API-токен панели для нас (x-ui setting -getApiToken -tokenName vps-panel).
// Панель хранит его в "Доступах"; на диске агента токен не остаётся.
func XuiToken(ctx context.Context) (map[string]any, error) {
	res, err := shell.Exec(ctx, time.Minute, nil, xuiBin, "setting", "-getApiToken", "-tokenName", "vps-panel")
	if err != nil {
		return nil, err
	}
	m := reApiToken.FindStringSubmatch(res.Stdout)
	if m == nil {
		return nil, errors.New("x-ui не выдал токен: " + firstLine(res.Stderr, res.Stdout))
	}
	return map[string]any{"token": m[1]}, nil
}

// XuiAPIRequest - запрос к REST API панели с локального адреса; токен приходит от панели на каждый вызов.
type XuiAPIRequest struct {
	Token  string          `json:"token"`
	Method string          `json:"method"`
	Path   string          `json:"path"` // относительно /panel/api/, например server/status
	Body   json.RawMessage `json:"body"`
	// Form - тело формой (application/x-www-form-urlencoded) вместо JSON: часть методов 3X-UI
	// (xray/update, xray/testOutbound, xray/routeTest) читает только форму.
	Form map[string]string `json:"form,omitempty"`
	// Query - параметры строки запроса (xray/geodata/categories?file=...).
	Query map[string]string `json:"query,omitempty"`
}

var reAPIPath = regexp.MustCompile(`^[A-Za-z0-9_./:-]{1,200}$`)

// newXuiRequest - запрос к REST 3X-UI: base - адрес /panel/api/ с завершающим слешем.
func newXuiRequest(ctx context.Context, base string, p XuiAPIRequest) (*http.Request, error) {
	url := base + strings.TrimPrefix(p.Path, "/")
	if len(p.Query) > 0 {
		q := neturl.Values{}
		for k, v := range p.Query {
			q.Set(k, v)
		}
		url += "?" + q.Encode()
	}
	method := strings.ToUpper(p.Method)
	if method == "" {
		method = http.MethodGet
	}
	var body io.Reader
	contentType := "application/json"
	if p.Form != nil {
		f := neturl.Values{}
		for k, v := range p.Form {
			f.Set(k, v)
		}
		body = strings.NewReader(f.Encode())
		contentType = "application/x-www-form-urlencoded"
	} else if len(p.Body) > 0 {
		body = strings.NewReader(string(p.Body))
	}
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+p.Token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", contentType)
	}
	return req, nil
}

func XuiAPI(ctx context.Context, p XuiAPIRequest) (map[string]any, error) {
	if p.Token == "" {
		return nil, errors.New("нет API-токена 3X-UI: его выпускает кнопка во вкладке 3X-UI")
	}
	if !reAPIPath.MatchString(p.Path) || strings.Contains(p.Path, "..") {
		return nil, errors.New("неверный путь API")
	}
	info, err := services.ReadXui(ctx, nil)
	if err != nil || info == nil {
		return nil, errors.New("настройки 3X-UI недоступны")
	}
	scheme := "http"
	if info.HTTPS {
		scheme = "https"
	}
	host := "127.0.0.1"
	if info.PanelListen != "" && info.PanelListen != "0.0.0.0" && info.PanelListen != "::" {
		host = info.PanelListen
	}
	base := fmt.Sprintf("%s://%s%s/panel/api/", scheme, net.JoinHostPort(host, strconv.Itoa(info.PanelPort)), strings.TrimSuffix(info.BasePath, "/"))
	req, err := newXuiRequest(ctx, base, p)
	if err != nil {
		return nil, err
	}
	url := req.URL.String()
	resp, err := localTLS.Do(req)
	if err != nil {
		return nil, fmt.Errorf("панель 3X-UI не отвечает на %s: %w", url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == 401 || resp.StatusCode == 403 {
		return nil, errors.New("3X-UI отверг API-токен: нужно перевыпустить его во вкладке 3X-UI")
	}
	out := map[string]any{"status": resp.StatusCode}
	if json.Valid(raw) {
		out["data"] = json.RawMessage(raw)
	} else {
		out["text"] = string(raw[:min(len(raw), 2000)])
	}
	return out, nil
}
