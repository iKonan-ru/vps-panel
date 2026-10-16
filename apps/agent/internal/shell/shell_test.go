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

func TestOutCache(t *testing.T) {
	f := t.TempDir() + "/n"
	cmd := "echo x >> " + f + "; wc -l < " + f
	if Out(context.Background(), "sh", "-c", cmd) != "1" || Out(context.Background(), "sh", "-c", cmd) != "2" {
		t.Fatal("без кэша команда выполняется каждый раз")
	}
	ctx := WithOutCache(context.Background())
	if a, b := Out(ctx, "sh", "-c", cmd), Out(ctx, "sh", "-c", cmd); a != "3" || b != "3" {
		t.Fatalf("в одном снимке команда выполнилась дважды: %s %s", a, b)
	}
	if Out(WithOutCache(context.Background()), "sh", "-c", cmd) != "4" {
		t.Fatal("кэш одного снимка виден другому")
	}
}
