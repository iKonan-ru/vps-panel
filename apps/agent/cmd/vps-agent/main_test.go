package main

import (
	"encoding/json"
	"sync"
	"sync/atomic"
	"testing"
)

func TestDecode(t *testing.T) {
	var p struct {
		Steps []string `json:"steps"`
	}
	if err := decode(json.RawMessage(`{"steps":"ufw"}`), &p); err == nil {
		t.Fatal("кривые параметры прошли без ошибки (пустой список шагов = все шаги)")
	}
	if err := decode(nil, &p); err != nil {
		t.Fatalf("пустые параметры: %v", err)
	}
	if err := decode(json.RawMessage(`{"steps":["ufw"]}`), &p); err != nil || len(p.Steps) != 1 {
		t.Fatalf("верные параметры: %v %v", err, p.Steps)
	}
}

// Вызовы во время работы - один повтор после неё, а не параллельные копии и не потеря.
func TestCoalesced(t *testing.T) {
	var runs, active, maxActive atomic.Int32
	entered := make(chan struct{}, 10)
	release := make(chan struct{})
	c := &coalesced{fn: func() {
		if n := active.Add(1); n > maxActive.Load() {
			maxActive.Store(n)
		}
		if runs.Add(1) == 1 {
			entered <- struct{}{}
			<-release
		}
		active.Add(-1)
	}}
	done := make(chan struct{})
	go func() { c.run(); close(done) }()
	<-entered
	var wg sync.WaitGroup
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); c.run() }()
	}
	wg.Wait()
	close(release)
	<-done
	if runs.Load() != 2 || maxActive.Load() != 1 {
		t.Fatalf("запусков %d (ждали 2), одновременно %d", runs.Load(), maxActive.Load())
	}
}
