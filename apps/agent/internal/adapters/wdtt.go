package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
)

// WDTT: admin API сервера wdtt-server - пароли пользователей. Токен и
// порты берутся на самом сервере: токен - /etc/wdtt/admin.token, порты - из ExecStart службы
// wdtt (её пишет deploy.sh). Запрос идёт на 127.0.0.1, сертификат самоподписанный - цепочку на
// localhost не проверяем.

var (
	wdttUnit      = "/etc/systemd/system/wdtt.service"
	wdttTokenFile = "/etc/wdtt/admin.token"
)

// WdttAPIRequest - вызов admin API: метод GET или POST, путь из белого списка, поля формы.
type WdttAPIRequest struct {
	Method string            `json:"method"`
	Path   string            `json:"path"`
	Form   map[string]string `json:"form"`
}

var wdttPaths = map[string]bool{
	"/admin/passwords":               true,
	"/admin/passwords/activate":      true,
	"/admin/passwords/deactivate":    true,
	"/admin/passwords/delete":        true,
	"/admin/passwords/update":        true,
	"/admin/passwords/unbind-device": true,
}

// WdttPorts - порты из ExecStart службы wdtt: DTLS (-listen адрес:порт), admin API
// (-admin-listen адрес:порт), WireGuard (-wg-port порт).
func WdttPorts() (dtls, admin, wg int, err error) {
	b, err := os.ReadFile(wdttUnit)
	if err != nil {
		return 0, 0, 0, errors.New("WDTT не установлен: нет службы wdtt")
	}
	last := func(p []int) int {
		if len(p) == 0 {
			return 0
		}
		return p[len(p)-1]
	}
	flags := services.WdttFlagPorts(string(b))
	dtls, admin, wg = last(flags["listen"]), last(flags["admin-listen"]), last(flags["wg-port"])
	if admin == 0 {
		return dtls, 0, wg, errors.New("в службе wdtt нет -admin-listen: admin API выключен")
	}
	return dtls, admin, wg, nil
}

// WdttAPI - вызов admin API; в ответе - статус, тело и порты DTLS и WireGuard (для ссылок).
func WdttAPI(ctx context.Context, p WdttAPIRequest) (map[string]any, error) {
	method := strings.ToUpper(p.Method)
	if method == "" {
		method = http.MethodGet
	}
	if method != http.MethodGet && method != http.MethodPost {
		return nil, errors.New("метод: GET или POST")
	}
	if !wdttPaths[p.Path] {
		return nil, errors.New("неверный путь admin API WDTT")
	}
	dtls, admin, wg, err := WdttPorts()
	if err != nil {
		return nil, err
	}
	tok, err := os.ReadFile(wdttTokenFile)
	token := strings.TrimSpace(string(tok))
	if err != nil || token == "" {
		return nil, errors.New("нет токена admin API WDTT (" + wdttTokenFile + ")")
	}
	form := url.Values{}
	for k, v := range p.Form {
		form.Set(k, v)
	}
	target := fmt.Sprintf("https://127.0.0.1:%d%s", admin, p.Path)
	var body io.Reader
	if method == http.MethodPost {
		body = strings.NewReader(form.Encode())
	} else if len(form) > 0 {
		target += "?" + form.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	}
	resp, err := localTLS.Do(req)
	if err != nil {
		return nil, fmt.Errorf("admin API WDTT не отвечает на 127.0.0.1:%d: %w", admin, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<20))
	if resp.StatusCode == http.StatusUnauthorized {
		return nil, errors.New("WDTT отверг токен admin API (" + wdttTokenFile + ")")
	}
	out := map[string]any{"status": resp.StatusCode, "dtlsPort": dtls, "wgPort": wg}
	if json.Valid(raw) {
		out["data"] = json.RawMessage(raw)
	} else {
		out["text"] = string(raw[:min(len(raw), 2000)])
	}
	return out, nil
}
