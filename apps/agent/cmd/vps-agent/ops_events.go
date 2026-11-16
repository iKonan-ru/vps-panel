package main

import (
	"context"
	"errors"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/adapters"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/eventlog"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/metrics"
)

// Журнал сервера на стороне агента: буфер и читатель журнала доступа xray (nil - не открыт).
var (
	events    atomic.Pointer[eventlog.Store]
	accessLog atomic.Pointer[eventlog.Access]
)

type pullParams struct {
	Epoch string `json:"epoch"`
	After int64  `json:"after"`
	Limit int    `json:"limit"`
}

// eventOps - забор журнала сервера панелью.
func eventOps() map[string]op {
	return map[string]op{
		// события после after (они подтверждены и удаляются из буфера)
		"events.pull": typed(func(_ context.Context, p pullParams, _ stream) (any, error) {
			store := events.Load()
			if store == nil {
				return nil, errors.New("журнал агента не открыт")
			}
			r := store.Pull(p.Epoch, p.After, p.Limit)
			if a := accessLog.Load(); a != nil {
				r.Access = a.Status()
			}
			// путь - из config.json сейчас: панель только что включила или выключила журнал
			r.Access.Path = eventlog.AccessLogPath()
			r.Access.Enabled = r.Access.Path != ""
			return r, nil
		}),
	}
}

// runEventlog - сбор журнала сервера раз в минуту: нагрузка, системный журнал, журнал доступа
// xray. Работает и без связи с панелью: события ждут в буфере.
func runEventlog(ctx context.Context, log *slog.Logger) {
	store, err := eventlog.Open(eventlog.DefaultDir, eventlog.DefaultMax)
	if err != nil {
		log.Warn("журнал сервера не открыт", "err", err)
		return
	}
	journal := eventlog.NewJournal(store, eventlog.DefaultDir)
	access := eventlog.NewAccess(store, eventlog.DefaultDir)
	events.Store(store)
	accessLog.Store(access)
	collector := metrics.NewCollector()
	// первый замер - только точка отсчёта скоростей сети
	_, _ = collector.Collect(ctx)
	tick := time.NewTicker(time.Minute)
	defer tick.Stop()
	n := 0
	poll := func() {
		if m, err := collector.Collect(ctx); err == nil {
			c := adapters.ServerConns(ctx)
			m.Conns = &c
			store.Add(time.Time{}, "metric", "info", "", "", m)
		}
		if err := journal.Poll(ctx); err != nil && ctx.Err() == nil && n%60 == 0 {
			log.Warn("системный журнал не прочитан", "err", err)
		}
		access.Poll()
		n++
	}
	access.Poll()
	for {
		select {
		case <-ctx.Done():
			journal.Close()
			return
		case <-tick.C:
			poll()
		}
	}
}
