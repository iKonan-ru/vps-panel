package adapters

import (
	"context"
	"encoding/json"
	"os"
	"testing"
)

// Живой прогон скрытия в трассировке против локального контейнера AWG (только при
// AWG_TRACE_LIVE=1): контейнер AWG_TRACE_CONTAINER, TRACE_SET=on|off - включить или выключить,
// пусто - только состояние. Состояние печатается JSON-строкой "STATE {...}" для сценария стенда.
func TestAwgTracerouteLive(t *testing.T) {
	if os.Getenv("AWG_TRACE_LIVE") != "1" {
		t.Skip()
	}
	ctx := context.Background()
	c := os.Getenv("AWG_TRACE_CONTAINER")
	if set := os.Getenv("TRACE_SET"); set != "" {
		st, err := AwgTracerouteSet(ctx, c, set == "on")
		if err != nil {
			t.Fatalf("set %s: %v", set, err)
		}
		t.Logf("после set %s: %+v applied=%v", set, st, st.Applied != nil && *st.Applied)
	}
	for _, i := range AwgStatusAll(ctx).Instances {
		if i.Container != c {
			continue
		}
		if i.Traceroute == nil {
			t.Fatal("в статусе нет traceroute")
		}
		for _, p := range i.Params {
			if p.Key == "PostUp" || p.Key == "PostDown" {
				t.Logf("хук в параметрах: %s = %s", p.Key, p.Value)
			}
		}
		b, _ := json.Marshal(i.Traceroute)
		t.Logf("STATE %s", b)
		return
	}
	t.Fatal("контейнер не найден")
}
