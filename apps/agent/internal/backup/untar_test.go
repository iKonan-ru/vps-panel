package backup

import (
	"archive/tar"
	"compress/gzip"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type entry struct {
	name, link, body string
	typ              byte
	mode             int64
}

func makeArchive(t *testing.T, entries []entry) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "a.tar.gz")
	f, _ := os.Create(p)
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		mode := e.mode
		if mode == 0 {
			mode = 0o644
		}
		h := &tar.Header{Name: e.name, Typeflag: e.typ, Linkname: e.link, Mode: mode, Size: int64(len(e.body))}
		if e.typ != tar.TypeReg {
			h.Size = 0
		}
		if err := tw.WriteHeader(h); err != nil {
			t.Fatal(err)
		}
		if e.typ == tar.TypeReg {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	tw.Close()
	gz.Close()
	f.Close()
	return p
}

func TestExtractStaysInside(t *testing.T) {
	outside := t.TempDir()
	dst := t.TempDir()
	a := makeArchive(t, []entry{
		{name: "etc/x-ui/x-ui.db", body: "db", typ: tar.TypeReg},
		{name: "../../escape", body: "x", typ: tar.TypeReg},
		{name: "/abs", body: "y", typ: tar.TypeReg},
		{name: "etc/suid", body: "z", typ: tar.TypeReg, mode: 0o4755},
		{name: "etc/link", link: "/etc/passwd", typ: tar.TypeSymlink},
	})
	if err := extractTarGz(a, dst, func(string, ...any) {}); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dst, "etc/x-ui/x-ui.db")); string(b) != "db" {
		t.Fatal("обычный файл не распаковался")
	}
	// ".." и абсолютный путь остаются внутри dst
	if _, err := os.Stat(filepath.Join(dst, "escape")); err != nil {
		t.Fatal("../../escape должен лечь в корень распаковки")
	}
	if _, err := os.Stat(filepath.Join(dst, "abs")); err != nil {
		t.Fatal("/abs должен лечь в корень распаковки")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("запись вне распаковки")
	}
	st, _ := os.Stat(filepath.Join(dst, "etc/suid"))
	if st.Mode()&os.ModeSetuid != 0 {
		t.Fatal("setuid должен сниматься")
	}
	if l, _ := os.Readlink(filepath.Join(dst, "etc/link")); l != "/etc/passwd" {
		t.Fatal("символическая ссылка восстанавливается как ссылка")
	}
}

func TestExtractRefusesWriteThroughSymlink(t *testing.T) {
	outside := t.TempDir()
	dst := t.TempDir()
	a := makeArchive(t, []entry{
		{name: "etc/evil", link: outside, typ: tar.TypeSymlink},
		{name: "etc/evil/pwned", body: "x", typ: tar.TypeReg},
	})
	err := extractTarGz(a, dst, func(string, ...any) {})
	if err == nil || !strings.Contains(err.Error(), "символическую ссылку") {
		t.Fatalf("ожидался отказ, получено %v", err)
	}
	if _, err := os.Stat(filepath.Join(outside, "pwned")); err == nil {
		t.Fatal("файл записан через ссылку за пределы распаковки")
	}
}
