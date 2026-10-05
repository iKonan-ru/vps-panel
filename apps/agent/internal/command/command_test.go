package command

import (
	"context"
	"strings"
	"testing"
	"time"
)

func TestRunTailAndExitCode(t *testing.T) {
	res, err := Run(context.Background(), Params{Script: "echo OK\\|a; echo WARN\\|b >&2; exit 3", Env: map[string]string{"X": "1"}}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if res.ExitCode != 3 || !strings.Contains(res.Tail, "OK|a\n") || !strings.Contains(res.Tail, "WARN|b\n") {
		t.Fatalf("%+v", res)
	}
}

// Отмена убивает всю группу и не ждёт фоновых потомков, державших вывод.
func TestCancelKillsGroup(t *testing.T) {
	go func() {
		time.Sleep(200 * time.Millisecond)
		Cancel("r1")
	}()
	start := time.Now()
	var out strings.Builder
	res, err := Run(context.Background(), Params{RunID: "r1", Script: "sleep 30 & sleep 30"}, func(_, chunk string) { out.WriteString(chunk) })
	if err != nil {
		t.Fatal(err)
	}
	if !res.Killed || res.ExitCode != 128+9 || time.Since(start) > 10*time.Second {
		t.Fatalf("%+v за %s", res, time.Since(start))
	}
	if !strings.Contains(out.String(), "Остановлено по запросу") {
		t.Fatal(out.String())
	}
}
