package main

import (
	"os"
	"regexp"
	"slices"
	"testing"
	"time"
)

// Операции агента и AgentMethodSchema в packages/protocol совпадают: панель не зовёт того, чего
// агент не умеет, а у агента нет операций, которых панель не знает.
func TestMethodsMatchProtocol(t *testing.T) {
	src, err := os.ReadFile("../../../../packages/protocol/src/agent.ts")
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
	got := methods(registry(""))
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
