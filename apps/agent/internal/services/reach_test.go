package services

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/reach"
)

func TestMtproxylReach(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "last.json")
	if mtproxylReach(p) != nil {
		t.Fatal("нет файла - nil")
	}
	_ = os.WriteFile(p, []byte(`{"checked_at":"2026-10-12T01:00:00Z","target":"1.2.3.4:443","level":"red","percentage":12.5,"total_probes":16,"success_probes":2,"error":"","probes":[{"city":"Tomsk","asn":1,"network":"N","status":"finished","tls_success":true,"tls_info":{"x":1},"raw_output":"HTTP/1.1 301"},{"city":"Kursk","status":"failed","tls_success":false,"raw_output":"HEAD /\nconnect ETIMEDOUT"},{"status":"in-progress"}]}`), 0o600)
	r := mtproxylReach(p)
	if r == nil || r["level"] != "red" || r["percent"] != 12.5 || r["total"] != 16 || r["ok"] != 2 {
		t.Fatalf("%v", r)
	}
	ps, _ := r["probes"].([]reach.Probe)
	if len(ps) != 2 || !ps[0].OK || ps[0].City != "Tomsk" || ps[1].OK || ps[1].Error != "connect ETIMEDOUT" {
		t.Fatalf("зонды коротко, без сырых ответов: %+v", ps)
	}
}
