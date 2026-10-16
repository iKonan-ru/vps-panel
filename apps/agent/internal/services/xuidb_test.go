package services

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestXuiDSNBusyTimeout(t *testing.T) {
	path := filepath.Join(t.TempDir(), "x-ui.db")
	w, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer w.Close()
	if _, err := w.Exec("create table settings (key text, value text)"); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", xuiDSN(path))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var ms, ro int
	if err := db.QueryRow("pragma busy_timeout").Scan(&ms); err != nil || ms != 5000 {
		t.Fatalf("busy_timeout: %d %v", ms, err)
	}
	if err := db.QueryRow("pragma query_only").Scan(&ro); err != nil || ro != 1 {
		t.Fatalf("query_only: %d %v", ro, err)
	}
}
