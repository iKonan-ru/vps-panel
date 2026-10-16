package services

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

func TestMtproxylVersionFromScript(t *testing.T) {
	p := filepath.Join(t.TempDir(), "mtproxyl.sh")
	_ = os.WriteFile(p, []byte("#!/bin/bash\n# VERSION=\"0\"\nset -e\nVERSION=\"1.7.5\"\nTELEMT_MIN_VERSION=\"3.5.13\"\n"), 0o755)
	if v := mtproxylVersion(context.Background(), p); v != "1.7.5" {
		t.Fatalf("версия из скрипта: %q", v)
	}
}
