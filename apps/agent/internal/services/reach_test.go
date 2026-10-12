package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMtproxylReach(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "last.json")
	if mtproxylReach(p) != nil {
		t.Fatal("нет файла - nil")
	}
	_ = os.WriteFile(p, []byte(`{"checked_at":"2026-10-12T01:00:00Z","target":"1.2.3.4:443","level":"red","percentage":12.5,"total_probes":16,"success_probes":2,"error":"","probes":[{"raw_output":"x"}]}`), 0o600)
	r := mtproxylReach(p)
	if r == nil || r["level"] != "red" || r["percent"] != 12.5 || r["total"] != 16 || r["ok"] != 2 {
		t.Fatalf("%v", r)
	}
	if _, has := r["probes"]; has {
		t.Fatal("ответы зондов в снимок не идут")
	}
}
