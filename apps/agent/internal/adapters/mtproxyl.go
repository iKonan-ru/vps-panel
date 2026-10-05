// Package adapters - экраны панели поверх CLI сервисов (MTProxyL, 3x-ui) без эмуляции
// их интерактивных меню: только команды с аргументами и JSON-вывод.
package adapters

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

const mtBin = "/usr/local/bin/mtproxyl"

// mtEnv: подтверждения mtproxyl ("введите yes") проходят сами - панель и есть подтверждение.
var mtEnv = []string{"MTPROXYL_ASSUME_YES=1", "MTPROXYL_NONINTERACTIVE=true"}

// MtStatus - всё, что нужно вкладке MTProxyL за один запрос.
type MtStatus struct {
	Installed   bool            `json:"installed"`
	Status      json.RawMessage `json:"status"`      // mtproxyl status --json
	Traffic     json.RawMessage `json:"traffic"`     // mtproxyl traffic --json
	Secrets     json.RawMessage `json:"secrets"`     // mtproxyl secret list --json
	UpdateCheck json.RawMessage `json:"updateCheck"` // mtproxyl update-check
	Panel       string          `json:"panel"`       // mtproxyl panel status (текст)
	Engine      string          `json:"engine"`      // версия движка telemt ("3.5.13"), "" - неизвестна
	Errors      []string        `json:"errors"`
}

// MtStatusAll собирает статус параллельно: каждый вызов mtproxyl - секунда на загрузку настроек.
func MtStatusAll(ctx context.Context) MtStatus {
	out := MtStatus{Installed: shell.Has("mtproxyl") || fileExists(mtBin), Errors: []string{}}
	if !out.Installed {
		return out
	}
	var mu sync.Mutex
	var wg sync.WaitGroup
	jsonCall := func(dst *json.RawMessage, args ...string) {
		defer wg.Done()
		res, err := shell.ExecEnv(ctx, 60*time.Second, nil, mtEnv, mtBin, args...)
		mu.Lock()
		defer mu.Unlock()
		if err != nil || res.ExitCode != 0 {
			out.Errors = append(out.Errors, fmt.Sprintf("mtproxyl %s: %s", strings.Join(args, " "), firstLine(res.Stderr, res.Stdout)))
			return
		}
		raw := strings.TrimSpace(stripAnsi(res.Stdout))
		if !json.Valid([]byte(raw)) {
			out.Errors = append(out.Errors, fmt.Sprintf("mtproxyl %s: не JSON", strings.Join(args, " ")))
			return
		}
		*dst = json.RawMessage(raw)
	}
	wg.Add(4)
	go jsonCall(&out.Status, "status", "--json")
	go jsonCall(&out.Traffic, "traffic", "--json")
	go jsonCall(&out.Secrets, "secret", "list", "--json")
	go jsonCall(&out.UpdateCheck, "update-check")
	wg.Add(1)
	go func() {
		defer wg.Done()
		res, _ := shell.ExecEnv(ctx, 30*time.Second, nil, mtEnv, mtBin, "panel", "status")
		mu.Lock()
		out.Panel = strings.TrimSpace(stripAnsi(res.Stdout + res.Stderr))
		mu.Unlock()
	}()
	wg.Wait()
	out.Engine = telemtVersion()
	return out
}

// telemtVersion - версия движка telemt, которую MTProxyL записывает при установке образа или
// бинарника ("3.5.13-d3de986" - версия и коммит релиза; коммит не показываем). В status --json
// поле version - версия самого MTProxyL.
func telemtVersion() string {
	b, err := os.ReadFile("/opt/mtproxyl/.telemt_version")
	if err != nil {
		return ""
	}
	v := strings.TrimPrefix(strings.TrimSpace(string(b)), "v")
	if i := strings.IndexByte(v, '-'); i > 0 {
		v = v[:i]
	}
	return v
}

// MtRequest - операция адаптера: имя и аргументы; каждая операция знает, что ей можно.
type MtRequest struct {
	Op   string            `json:"op"`
	Args map[string]string `json:"args"`
}

var (
	// без ведущего "-": метка - аргумент CLI, "--all" стал бы опцией
	reLabel = regexp.MustCompile(`^[a-zA-Z0-9_][a-zA-Z0-9_-]{0,31}$`)
	reHex   = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	reTag   = regexp.MustCompile(`^v?[0-9][0-9A-Za-z.+-]{0,40}$`)
)

// mtOps - белый список операций: аргументы проверяются, argv собирается без оболочки.
var mtOps = map[string]struct {
	build   func(a map[string]string) ([]string, error)
	timeout time.Duration
	restart bool // после операции нужен mtproxyl restart, чтобы движок подхватил
}{
	"secret.add": {func(a map[string]string) ([]string, error) {
		if !reLabel.MatchString(a["label"]) {
			return nil, errors.New("метка: только a-z, 0-9, _ и -, до 32 символов")
		}
		args := []string{"secret", "add", a["label"]}
		if s := a["secret"]; s != "" {
			if !reHex.MatchString(s) {
				return nil, errors.New("секрет: 32 hex-символа")
			}
			args = append(args, s)
		}
		return args, nil
	}, time.Minute, false},
	"secret.remove":  {labelOp("secret", "remove"), time.Minute, false},
	"secret.enable":  {labelOp("secret", "enable"), time.Minute, false},
	"secret.disable": {labelOp("secret", "disable"), time.Minute, false},
	"secret.link":    {labelOp("secret", "link"), 30 * time.Second, false},
	"secret.rename": {func(a map[string]string) ([]string, error) {
		if !reLabel.MatchString(a["label"]) || !reLabel.MatchString(a["new"]) {
			return nil, errors.New("метка: только a-z, 0-9, _ и -, до 32 символов")
		}
		return []string{"secret", "rename", a["label"], a["new"]}, nil
	}, time.Minute, false},
	"restart":       {fixed("restart"), 3 * time.Minute, false},
	"update":        {fixed("update", "--no-restart"), 10 * time.Minute, true},
	"panel.restart": {fixed("panel", "restart"), 2 * time.Minute, false},
	"panel.update":  {fixed("panel", "update"), 10 * time.Minute, false},
	// Движок telemt: образ docker или бинарник. versions - JSON с текущей версией и релизами,
	// update с тегом не задаёт вопросов и сам перезапускает прокси; без тега меню ждёт ввода.
	"engine.versions": {fixed("engine", "versions"), time.Minute, false},
	"engine.update": {func(a map[string]string) ([]string, error) {
		if !reTag.MatchString(a["version"]) {
			return nil, errors.New("версия: тег релиза telemt")
		}
		return []string{"engine", "update", a["version"]}, nil
	}, 14 * time.Minute, false}, // меньше 15 минут, которые ждёт панель
}

func labelOp(parts ...string) func(map[string]string) ([]string, error) {
	return func(a map[string]string) ([]string, error) {
		if !reLabel.MatchString(a["label"]) {
			return nil, errors.New("метка: только a-z, 0-9, _ и -, до 32 символов")
		}
		return append(append([]string{}, parts...), a["label"]), nil
	}
}

func fixed(parts ...string) func(map[string]string) ([]string, error) {
	return func(map[string]string) ([]string, error) { return parts, nil }
}

// MtExec выполняет операцию из белого списка; вывод идёт в stream, итог - код и хвост.
func MtExec(ctx context.Context, req MtRequest, stream func(channel, chunk string)) (map[string]any, error) {
	op, ok := mtOps[req.Op]
	if !ok {
		return nil, errors.New("неизвестная операция: " + req.Op)
	}
	if req.Args == nil {
		req.Args = map[string]string{}
	}
	args, err := op.build(req.Args)
	if err != nil {
		return nil, err
	}
	log := func(s string) {
		if stream != nil {
			stream("log", s+"\n")
		}
	}
	log("$ mtproxyl " + strings.Join(args, " "))
	res, err := shell.ExecEnv(ctx, op.timeout, stream, mtEnv, mtBin, args...)
	if err != nil {
		return nil, err
	}
	if res.ExitCode != 0 {
		return nil, fmt.Errorf("mtproxyl завершился с кодом %d: %s", res.ExitCode, firstLine(res.Stderr, res.Stdout))
	}
	if op.restart {
		log("$ mtproxyl restart")
		r2, err := shell.ExecEnv(ctx, 3*time.Minute, stream, mtEnv, mtBin, "restart")
		if err != nil {
			return nil, err
		}
		if r2.ExitCode != 0 {
			return nil, fmt.Errorf("mtproxyl restart завершился с кодом %d", r2.ExitCode)
		}
	}
	return map[string]any{"ok": true, "output": stripAnsi(res.Stdout)}, nil
}

var ansiRe = regexp.MustCompile("\x1b\\[[0-9;?]*[A-Za-z]")

func stripAnsi(s string) string { return ansiRe.ReplaceAllString(s, "") }

func firstLine(parts ...string) string {
	for _, p := range parts {
		for _, l := range strings.Split(stripAnsi(p), "\n") {
			if l = strings.TrimSpace(l); l != "" {
				return l
			}
		}
	}
	return "без вывода"
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}
