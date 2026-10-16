package fsutil

import (
	"os"
	"path/filepath"
	"testing"
)

func TestWriteAtomic(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "a.conf")
	if err := os.WriteFile(p, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(p, []byte("new"), 0o600); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	st, _ := os.Stat(p)
	if string(b) != "new" || st.Mode().Perm() != 0o600 {
		t.Fatalf("содержимое %q, права %v", b, st.Mode().Perm())
	}
	if entries, _ := os.ReadDir(dir); len(entries) != 1 {
		t.Fatalf("остались временные файлы: %v", entries)
	}
	if err := WriteAtomic(filepath.Join(dir, "нет", "b"), []byte("x"), 0o600); err == nil {
		t.Fatal("запись в несуществующий каталог прошла")
	}
}

func TestFileSum(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	_ = os.WriteFile(p, []byte("abc"), 0o600)
	if s, err := FileSum(p); err != nil || s != "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" {
		t.Fatalf("%s %v", s, err)
	}
}

func TestWriteAtomicKeepsSymlink(t *testing.T) {
	dir := t.TempDir()
	target, link := filepath.Join(dir, "real.conf"), filepath.Join(dir, "link.conf")
	_ = os.WriteFile(target, []byte("old"), 0o644)
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	if err := WriteAtomic(link, []byte("new"), 0o644); err != nil {
		t.Fatal(err)
	}
	if fi, _ := os.Lstat(link); fi.Mode()&os.ModeSymlink == 0 {
		t.Fatal("ссылка заменена файлом")
	}
	if b, _ := os.ReadFile(target); string(b) != "new" {
		t.Fatalf("файл по ссылке: %q", b)
	}
}
