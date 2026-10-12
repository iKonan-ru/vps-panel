// Package reach - проверка "видно ли из России": измерения Globalping с адреса этого сервера.
// Зонды Globalping в российских домашних сетях (eyeball-network) пробуют дойти до цели: TCP до
// порта (ping по TCP) или TLS-рукопожатие с нужным SNI (HTTPS HEAD). Квота Globalping считается
// по адресу запроса - поэтому заказывает агент, а не панель: у каждого сервера своя.
package reach

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// API - адрес Globalping (в тестах - свой сервер).
var API = "https://api.globalping.io/v1"

// Target - что проверить: kind "tcp" - TCP до порта, "tls" - TLS-рукопожатие с SNI.
type Target struct {
	Key  string `json:"key"`
	Kind string `json:"kind"`
	Host string `json:"host"`
	Port int    `json:"port"`
	SNI  string `json:"sni"`
}

// Params - запрос панели: цели, зондов на цель (1-50, по умолчанию 10), токен Globalping
// (необязательно: с ним квота вдвое больше).
type Params struct {
	Token   string   `json:"token"`
	Probes  int      `json:"probes"`
	Targets []Target `json:"targets"`
}

// Result - итог по цели: сколько зондов ответило (без не успевших) и сколько дошло.
type Result struct {
	Key     string   `json:"key"`
	Total   int      `json:"total"`
	OK      int      `json:"ok"`
	Percent float64  `json:"percent"`
	Errors  []string `json:"errors"`
	// Error - проверка не состоялась (квота, сеть, Globalping); тогда Total = 0.
	Error string `json:"error,omitempty"`
}

// Reply - итоги по целям и остаток квоты с этого адреса (-1 - неизвестен).
type Reply struct {
	Results   []Result `json:"results"`
	Remaining int      `json:"remaining"`
}

var (
	reHost = regexp.MustCompile(`^[A-Za-z0-9.-]{1,253}$`)
	reKey  = regexp.MustCompile(`^[A-Za-z0-9:._-]{1,64}$`)
	client = &http.Client{Timeout: 20 * time.Second}
)

// pollEvery и waitFor - опрос итога: Globalping разрешает 2 запроса в секунду на измерение.
var (
	pollEvery = time.Second
	waitFor   = 35 * time.Second
)

func validate(p *Params) error {
	if len(p.Targets) == 0 || len(p.Targets) > 12 {
		return errors.New("целей должно быть от 1 до 12")
	}
	if p.Probes <= 0 {
		p.Probes = 10
	}
	if p.Probes > 50 {
		p.Probes = 50
	}
	for _, t := range p.Targets {
		if !reKey.MatchString(t.Key) {
			return fmt.Errorf("неверный ключ цели %q", t.Key)
		}
		if t.Kind != "tcp" && t.Kind != "tls" {
			return fmt.Errorf("цель %s: вид tcp или tls", t.Key)
		}
		if net.ParseIP(t.Host) == nil && !reHost.MatchString(t.Host) {
			return fmt.Errorf("цель %s: неверный адрес", t.Key)
		}
		if t.Port < 1 || t.Port > 65535 {
			return fmt.Errorf("цель %s: неверный порт", t.Key)
		}
		if t.SNI != "" && !reHost.MatchString(t.SNI) {
			return fmt.Errorf("цель %s: неверный SNI", t.Key)
		}
	}
	return nil
}

// request - тело POST /measurements для цели.
func request(t Target, probes int) map[string]any {
	loc := []map[string]any{{"country": "RU", "tags": []string{"eyeball-network"}}}
	if t.Kind == "tcp" {
		return map[string]any{
			"type":               "ping",
			"target":             t.Host,
			"measurementOptions": map[string]any{"protocol": "TCP", "port": t.Port, "packets": 3},
			"locations":          loc,
			"limit":              probes,
		}
	}
	req := map[string]any{"method": "HEAD"}
	if t.SNI != "" {
		// Host уходит и в SNI: так проверяется именно то, что видит клиент (Reality, FakeTLS)
		req["host"] = t.SNI
	}
	return map[string]any{
		"type":               "http",
		"target":             t.Host,
		"measurementOptions": map[string]any{"protocol": "HTTPS", "port": t.Port, "request": req},
		"locations":          loc,
		"limit":              probes,
	}
}

// Check заказывает измерения по всем целям и ждёт итогов (до ~35 с). Отказ квоты (429) на одной
// цели - отказ и для остальных: заказывать дальше бессмысленно.
func Check(ctx context.Context, p Params) (Reply, error) {
	if err := validate(&p); err != nil {
		return Reply{}, err
	}
	reply := Reply{Results: make([]Result, len(p.Targets)), Remaining: -1}
	ids := make([]string, len(p.Targets))
	var limited string
	for i, t := range p.Targets {
		reply.Results[i] = Result{Key: t.Key, Errors: []string{}}
		if limited != "" {
			reply.Results[i].Error = limited
			continue
		}
		id, rem, err := create(ctx, p.Token, request(t, p.Probes))
		if rem >= 0 {
			reply.Remaining = rem
		}
		if err != nil {
			reply.Results[i].Error = err.Error()
			if errors.Is(err, errLimited) {
				limited = err.Error()
			}
			continue
		}
		ids[i] = id
	}
	var wg sync.WaitGroup
	for i, t := range p.Targets {
		if ids[i] == "" {
			continue
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			body, err := wait(ctx, p.Token, ids[i])
			if err != nil {
				reply.Results[i].Error = err.Error()
				return
			}
			r := Parse(t.Kind, body)
			r.Key = t.Key
			reply.Results[i] = r
		}()
	}
	wg.Wait()
	return reply, nil
}

var errLimited = errors.New("квота Globalping")

func do(ctx context.Context, method, url, token string, body []byte) (*http.Response, []byte, error) {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, rd)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "vps-panel-agent")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, nil, fmt.Errorf("Globalping недоступен: %w", unwrapURL(err))
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	return resp, raw, nil
}

func unwrapURL(err error) error {
	var ue interface{ Unwrap() error }
	if errors.As(err, &ue) {
		if in := ue.Unwrap(); in != nil {
			return in
		}
	}
	return err
}

func create(ctx context.Context, token string, body map[string]any) (string, int, error) {
	raw, _ := json.Marshal(body)
	resp, out, err := do(ctx, http.MethodPost, API+"/measurements", token, raw)
	if err != nil {
		return "", -1, err
	}
	rem := -1
	if v, e := strconv.Atoi(resp.Header.Get("X-RateLimit-Remaining")); e == nil {
		rem = v
	}
	if resp.StatusCode == http.StatusTooManyRequests {
		msg := "исчерпана с адреса сервера"
		if v, e := strconv.Atoi(resp.Header.Get("X-RateLimit-Reset")); e == nil && v > 0 {
			msg = fmt.Sprintf("%s, вернётся через %d мин", msg, (v+59)/60)
		}
		return "", 0, fmt.Errorf("%w %s", errLimited, msg)
	}
	if resp.StatusCode != http.StatusAccepted && resp.StatusCode != http.StatusOK {
		return "", rem, fmt.Errorf("Globalping ответил %d: %s", resp.StatusCode, short(string(out)))
	}
	var v struct {
		ID string `json:"id"`
	}
	if json.Unmarshal(out, &v) != nil || v.ID == "" || !reKey.MatchString(v.ID) {
		return "", rem, errors.New("Globalping не вернул id измерения")
	}
	return v.ID, rem, nil
}

func wait(ctx context.Context, token, id string) ([]byte, error) {
	deadline := time.Now().Add(waitFor)
	for {
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(pollEvery):
		}
		resp, body, err := do(ctx, http.MethodGet, API+"/measurements/"+id, token, nil)
		if err != nil {
			return nil, err
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("Globalping ответил %d на запрос итога", resp.StatusCode)
		}
		var st struct {
			Status string `json:"status"`
		}
		_ = json.Unmarshal(body, &st)
		// время вышло - берём, что есть: не успевшие зонды в итог не входят
		if st.Status != "in-progress" || time.Now().After(deadline) {
			return body, nil
		}
	}
}

// Parse - итог измерения: дошёл ли каждый зонд. tcp - ответ хотя бы на один TCP-пакет, tls -
// получен сертификат (TLS-рукопожатие прошло). Зонды, не успевшие ответить, не считаются.
func Parse(kind string, body []byte) Result {
	var m struct {
		Results []struct {
			Result struct {
				Status    string          `json:"status"`
				RawOutput string          `json:"rawOutput"`
				TLS       json.RawMessage `json:"tls"`
				Stats     *struct {
					Rcv int `json:"rcv"`
				} `json:"stats"`
			} `json:"result"`
		} `json:"results"`
	}
	r := Result{Errors: []string{}}
	if err := json.Unmarshal(body, &m); err != nil {
		r.Error = "не удалось разобрать ответ Globalping"
		return r
	}
	seen := map[string]bool{}
	for _, x := range m.Results {
		if x.Result.Status == "in-progress" || x.Result.Status == "" {
			continue
		}
		r.Total++
		ok := x.Result.Status == "finished"
		if kind == "tcp" {
			ok = ok && x.Result.Stats != nil && x.Result.Stats.Rcv > 0
		} else {
			ok = ok && len(x.Result.TLS) > 0 && string(x.Result.TLS) != "null"
		}
		if ok {
			r.OK++
			continue
		}
		e := short(lastLine(x.Result.RawOutput))
		if e == "" {
			e = "соединение не установлено"
		}
		if !seen[e] && len(r.Errors) < 3 {
			seen[e] = true
			r.Errors = append(r.Errors, e)
		}
	}
	if r.Total > 0 {
		r.Percent = float64(r.OK*1000/r.Total) / 10
	} else {
		r.Error = "ни один российский зонд не взялся за проверку"
	}
	return r
}

// lastLine - последняя непустая строка вывода зонда: у ping там итог ("100% packet loss"), у
// http - текст ошибки; первая строка у ping - только заголовок "PING ... on port N".
func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

func short(s string) string {
	s = strings.TrimSpace(s)
	if r := []rune(s); len(r) > 160 {
		s = string(r[:160])
	}
	return s
}
