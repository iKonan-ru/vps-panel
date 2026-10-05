package shell

import (
	"context"
	"testing"
	"time"
)

// Таймаут убивает всё дерево процессов: потомки bash держали бы вывод, и вызов ждал бы их.
func TestRunTimeoutKillsChildren(t *testing.T) {
	start := time.Now()
	res, _ := Run(context.Background(), "(sleep 30) & sleep 30; echo done", 500*time.Millisecond, nil)
	if d := time.Since(start); d > 3*time.Second {
		t.Fatalf("вызов с таймаутом 0.5 с шёл %s", d)
	}
	if res.ExitCode == 0 {
		t.Fatalf("убитая команда вернула код 0: %+v", res)
	}
}

func TestRunOutput(t *testing.T) {
	res, err := Run(context.Background(), "echo a; echo b >&2; exit 3", 5*time.Second, nil)
	if err != nil || res.ExitCode != 3 || res.Stdout != "a\n" || res.Stderr != "b\n" {
		t.Fatalf("неожиданный итог: %+v %v", res, err)
	}
}

func TestQuote(t *testing.T) {
	if Quote("a b'c") != `'a b'\''c'` {
		t.Fatal(Quote("a b'c"))
	}
	if Quote("/etc/x-ui/x-ui.db") != "/etc/x-ui/x-ui.db" {
		t.Fatal("simple path must stay bare")
	}
}
