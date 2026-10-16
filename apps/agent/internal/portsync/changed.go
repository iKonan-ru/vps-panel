package portsync

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/fsutil"
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

// AttemptPath - последний запуск полного прохода по записи в базу 3x-ui: отпечаток и время.
const AttemptPath = "/var/lib/vps-portsync/attempt.json"

// XuiChanged - нужен ли полный проход после записи в базу 3x-ui. 3x-ui пишет в неё каждые
// несколько секунд (счётчики трафика): проход нужен, только если изменилось то, что port-sync из
// неё берёт (отпечаток не тот, что у прошлого полного прохода), или полный проход был давно.
// База не нативная, на PostgreSQL или не прочиталась - проход нужен.
func XuiChanged(ctx context.Context, now time.Time) bool {
	changed, _ := xuiChanged(ctx, now)
	return changed
}

// xuiChanged - XuiChanged и отпечаток базы ("" - не прочитана).
func xuiChanged(ctx context.Context, now time.Time) (bool, string) {
	if services.ReadXuiDBConfig().Type == "postgres" {
		return true, ""
	}
	native := services.XuiNativeDB()
	if _, err := os.Stat(native); err != nil {
		return true, ""
	}
	x, err := services.ReadXuiWith(ctx, func() string { return native })
	if err != nil || x == nil || x.InboundsErr != nil {
		return true, ""
	}
	var st struct {
		XuiFP  string  `json:"xui_fp"`
		FullAt float64 `json:"full_at"`
	}
	b, err := os.ReadFile(hostfs.Path(StatePath))
	if err != nil || json.Unmarshal(b, &st) != nil {
		return true, x.Fingerprint
	}
	return !fresh(now, st.FullAt) || st.XuiFP == "" || st.XuiFP != x.Fingerprint, x.Fingerprint
}

func fresh(now time.Time, at float64) bool {
	age := float64(now.UnixNano())/1e9 - at
	return age >= 0 && age < FullEvery.Seconds()
}

// StartFull - запускать ли полный проход по записи в базу 3x-ui. Да - попытка запоминается: если
// проход не удался (состояния нет, full_at не обновился), тот же отпечаток запускает его снова не
// раньше, чем через FullEvery, а не на каждую запись 3x-ui.
func StartFull(ctx context.Context, now time.Time) bool {
	changed, fp := xuiChanged(ctx, now)
	if !changed {
		return false
	}
	type attempt struct {
		XuiFP string  `json:"xui_fp"`
		At    float64 `json:"at"`
	}
	var a attempt
	if b, err := os.ReadFile(hostfs.Path(AttemptPath)); err == nil && json.Unmarshal(b, &a) == nil &&
		a.XuiFP == fp && fresh(now, a.At) {
		return false
	}
	b, _ := json.Marshal(attempt{XuiFP: fp, At: float64(now.UnixNano()) / 1e9})
	_ = os.MkdirAll(filepath.Dir(hostfs.Path(AttemptPath)), 0o755)
	_ = fsutil.WriteAtomic(hostfs.Path(AttemptPath), b, 0o644)
	return true
}
