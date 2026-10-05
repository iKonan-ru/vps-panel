package cleanup

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestOldTmp(t *testing.T) {
	dir := t.TempDir()
	old := time.Now().Add(-30 * 24 * time.Hour)
	mk := func(rel string, isDir bool, mtime time.Time) string {
		p := filepath.Join(dir, rel)
		if isDir {
			_ = os.MkdirAll(p, 0o755)
		} else {
			_ = os.MkdirAll(filepath.Dir(p), 0o755)
			_ = os.WriteFile(p, []byte("x"), 0o644)
		}
		_ = os.Chtimes(p, mtime, mtime)
		return p
	}
	oldFile := mk("old.txt", false, old)
	mk("busy/fresh.log", false, time.Now())
	busy := mk("busy", true, old)
	mk("stale/a.txt", false, old)
	stale := mk("stale", true, old)
	private := mk("systemd-private-abc-nginx.service-x", true, old)
	tmux := mk("tmux-0", true, old)
	cases := map[string]bool{oldFile: true, busy: false, stale: true, private: false, tmux: false}
	for p, want := range cases {
		fi, _ := os.Lstat(p)
		if got := oldTmp(p, fi, 7*24*time.Hour); got != want {
			t.Errorf("%s: %v, ожидалось %v", filepath.Base(p), got, want)
		}
	}
}
