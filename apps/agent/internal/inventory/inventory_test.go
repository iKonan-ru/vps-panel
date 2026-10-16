package inventory

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

func TestUncheckedKinds(t *testing.T) {
	cases := []struct {
		name         string
		dockerFailed bool
		xuiErr       error
		xuiFound     bool
		want         []string
	}{
		{"всё прочиталось", false, nil, true, []string{}},
		{"3X-UI нет, docker ответил", false, nil, false, []string{}},
		{"база 3X-UI не прочиталась", false, errors.New("locked"), false, []string{"xui"}},
		{"docker не ответил, 3X-UI на хосте", true, nil, true, []string{"amnezia", "wg-easy"}},
		{"docker не ответил, 3X-UI не найдена", true, nil, false, []string{"xui", "amnezia", "wg-easy"}},
	}
	for _, c := range cases {
		if got := uncheckedKinds(c.dockerFailed, c.xuiErr, c.xuiFound); !slices.Equal(got, c.want) {
			t.Errorf("%s: %v, ждали %v", c.name, got, c.want)
		}
	}
}

func TestSnapshotJSONIsInventory(t *testing.T) {
	inv := proto.Inventory{Services: []proto.Service{{Kind: "xui"}}, Unchecked: []string{"amnezia"}, CollectedAt: "2026-01-01T00:00:00Z"}
	a, _ := json.Marshal(inv)
	b, _ := json.Marshal(Snapshot{Inventory: inv, health: "xui"})
	if string(a) != string(b) {
		t.Fatalf("снимок в JSON отличается от Inventory:\n%s\n%s", a, b)
	}
}

// Вызовы во время сбора ждут один следующий сбор, начатый после них.
func TestCollectCoalesces(t *testing.T) {
	var mu sync.Mutex
	runs := 0
	release := make(chan struct{})
	collectFn = func(context.Context, string) (Snapshot, error) {
		mu.Lock()
		runs++
		n := runs
		mu.Unlock()
		if n == 1 {
			<-release
		}
		return Snapshot{health: fmt.Sprint(n)}, nil
	}
	defer func() { collectFn = collect }()

	first := make(chan Snapshot)
	go func() {
		s, _ := Collect(context.Background(), "")
		first <- s
	}()
	for {
		flight.Lock()
		started := flight.running != nil
		flight.Unlock()
		if started {
			break
		}
		time.Sleep(time.Millisecond)
	}
	var wg sync.WaitGroup
	got := make([]string, 5)
	for i := range got {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			s, _ := Collect(context.Background(), "")
			got[i] = s.Health()
		}(i)
	}
	for {
		flight.Lock()
		queued := flight.queued != nil
		flight.Unlock()
		if queued {
			break
		}
		time.Sleep(time.Millisecond)
	}
	time.Sleep(20 * time.Millisecond)
	close(release)
	if s := <-first; s.Health() != "1" {
		t.Fatalf("первый вызов получил сбор %s", s.Health())
	}
	wg.Wait()
	for _, h := range got {
		if h != "2" {
			t.Fatalf("ждавшие вызовы должны получить один общий второй сбор: %v", got)
		}
	}
	if runs != 2 {
		t.Fatalf("сборов %d, ждали 2", runs)
	}
}
