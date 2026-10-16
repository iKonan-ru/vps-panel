package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/config"
)

// Операции агента и AgentMethodSchema в packages/protocol совпадают: панель не зовёт того, чего
// агент не умеет, а у агента нет операций, которых панель не знает.
func TestMethodsMatchProtocol(t *testing.T) {
	src, err := os.ReadFile("../../../../packages/protocol/src/wire.ts")
	if err != nil {
		t.Fatal(err)
	}
	enum := regexp.MustCompile(`(?s)AgentMethodSchema = z\.enum\(\[(.*?)\]\)`).FindSubmatch(src)
	if enum == nil {
		t.Fatal("AgentMethodSchema не найден")
	}
	var proto []string
	for _, m := range regexp.MustCompile(`'([a-z.]+)'`).FindAllSubmatch(enum[1], -1) {
		proto = append(proto, string(m[1]))
	}
	slices.Sort(proto)
	got := methods(withConfigOps(registry(""), &config.Config{}, ""))
	for _, m := range got {
		if !slices.Contains(proto, m) {
			t.Errorf("операции %s нет в AgentMethodSchema", m)
		}
	}
	for _, m := range proto {
		if !slices.Contains(got, m) {
			t.Errorf("метод %s из AgentMethodSchema агент не умеет", m)
		}
	}
}

// Частоту меняют чаще, чем цикл отправки её читает: остаётся последняя, вызов не блокируется.
func TestSetMetricsEveryKeepsLast(t *testing.T) {
	setMetricsEvery(2 * time.Second)
	setMetricsEvery(slowMetrics)
	if d := <-metricsEvery; d != slowMetrics {
		t.Fatalf("частота %s, ждали %s", d, slowMetrics)
	}
	select {
	case d := <-metricsEvery:
		t.Fatalf("лишнее значение в канале: %s", d)
	default:
	}
}

func TestPanelURLOp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "agent.json")
	cfg := &config.Config{PanelURL: "https://203.0.113.10", Token: "t"}
	restarts := 0
	restartLater = func() error { restarts++; return nil }
	o := panelURLOp(cfg, path)
	call := func(url string) (any, error) {
		return o(context.Background(), json.RawMessage(`{"url":"`+url+`"}`), nil)
	}
	if _, err := call("http://panel.example.com"); err == nil {
		t.Fatal("только https")
	}
	r, err := call("https://203.0.113.10")
	if err != nil || r.(map[string]any)["changed"] != false || restarts != 0 {
		t.Fatalf("тот же адрес - без перезапуска: %v %v", r, err)
	}
	if r, err = call("https://panel.example.com"); err != nil || r.(map[string]any)["changed"] != true || restarts != 1 {
		t.Fatalf("новый адрес: %v %v", r, err)
	}
	saved, err := os.ReadFile(path)
	if err != nil || !strings.Contains(string(saved), `"panelUrl": "https://panel.example.com"`) {
		t.Fatalf("сохранён: %s %v", saved, err)
	}
}
