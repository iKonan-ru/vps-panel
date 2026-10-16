package portsync

import (
	"context"
	"encoding/json"
	"os"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/services"
)

// StatePath - state.json port-sync: правила, которые он поставил, отпечаток 3x-ui и время
// полного прохода.
const StatePath = "/var/lib/vps-portsync/state.json"

// FullEvery - полный проход не реже, чем раз в столько (как таймер port-sync). Таймер считает
// от последнего запуска vps-portsync.service любым путём, поэтому без этого частые запуски по
// изменениям могли бы отодвигать полный проход бесконечно.
const FullEvery = 120 * time.Second

// XuiChanged - нужен ли полный проход после записи в базу 3x-ui. 3x-ui пишет в неё каждые
// несколько секунд (счётчики трафика): проход нужен, только если изменилось то, что port-sync из
// неё берёт (отпечаток не тот, что у прошлого полного прохода), или полный проход был давно.
// База не нативная, на PostgreSQL или не прочиталась - проход нужен.
func XuiChanged(ctx context.Context, now time.Time) bool {
	if services.ReadXuiDBConfig().Type == "postgres" {
		return true
	}
	native := services.XuiNativeDB()
	if _, err := os.Stat(native); err != nil {
		return true
	}
	x, err := services.ReadXuiWith(ctx, func() string { return native })
	if err != nil || x == nil || x.InboundsErr != nil {
		return true
	}
	var st struct {
		XuiFP  string  `json:"xui_fp"`
		FullAt float64 `json:"full_at"`
	}
	b, err := os.ReadFile(hostfs.Path(StatePath))
	if err != nil || json.Unmarshal(b, &st) != nil {
		return true
	}
	age := float64(now.UnixNano())/1e9 - st.FullAt
	fresh := age >= 0 && age < FullEvery.Seconds()
	return !fresh || st.XuiFP == "" || st.XuiFP != x.Fingerprint
}
