package audit

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestPendingUpdatesCache(t *testing.T) {
	dir := t.TempDir()
	status := filepath.Join(dir, "status")
	lists := filepath.Join(dir, "lists")
	if err := os.WriteFile(status, []byte("a"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(lists, 0o755); err != nil {
		t.Fatal(err)
	}
	oldWatch, oldCount, oldTTL := updWatch, updCount, updTTL
	defer func() {
		updWatch, updCount, updTTL = oldWatch, oldCount, oldTTL
		InvalidateUpdates()
	}()
	calls := 0
	updWatch = []string{status, lists}
	updCount = func(context.Context) int { calls++; return calls }
	updTTL = time.Hour
	InvalidateUpdates()
	ctx := context.Background()

	if n := PendingUpdates(ctx); n != 1 || calls != 1 {
		t.Fatalf("первый вызов считает: n=%d calls=%d", n, calls)
	}
	if n := PendingUpdates(ctx); n != 1 || calls != 1 {
		t.Fatalf("без изменений - из кэша: n=%d calls=%d", n, calls)
	}
	// apt update обновил списки
	later := time.Now().Add(time.Minute)
	if err := os.Chtimes(lists, later, later); err != nil {
		t.Fatal(err)
	}
	if n := PendingUpdates(ctx); n != 2 {
		t.Fatalf("после изменения списков - пересчёт: n=%d", n)
	}
	// установка пакетов изменила базу dpkg
	if err := os.Chtimes(status, later.Add(time.Minute), later.Add(time.Minute)); err != nil {
		t.Fatal(err)
	}
	if n := PendingUpdates(ctx); n != 3 {
		t.Fatalf("после изменения базы dpkg - пересчёт: n=%d", n)
	}
	// срок вышел - пересчёт и без изменений файлов
	updTTL = 0
	if n := PendingUpdates(ctx); n != 4 {
		t.Fatalf("после срока - пересчёт: n=%d", n)
	}
	updTTL = time.Hour
	InvalidateUpdates()
	if n := PendingUpdates(ctx); n != 5 {
		t.Fatalf("после сброса - пересчёт: n=%d", n)
	}
}
