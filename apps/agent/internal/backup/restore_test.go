package backup

import (
	"os"
	"path/filepath"
	"testing"
)

func TestCopyBackResult(t *testing.T) {
	ex, root := t.TempDir(), t.TempDir()
	nolog := func(string, ...any) {}
	if !copyBack(ex, filepath.Join(root, "absent"), nolog) {
		t.Fatal("того, чего нет в архиве, ошибкой быть не должно")
	}
	// в архиве есть, а на место не положить: родитель - файл
	blocker := filepath.Join(root, "file")
	_ = os.WriteFile(blocker, []byte("x"), 0o644)
	dst := filepath.Join(blocker, "conf")
	_ = os.MkdirAll(filepath.Join(ex, dst), 0o755)
	if copyBack(ex, dst, nolog) {
		t.Fatal("неудачное восстановление вернуло успех")
	}
	ok := filepath.Join(root, "etc", "app")
	_ = os.MkdirAll(filepath.Join(ex, ok), 0o755)
	if !copyBack(ex, ok, nolog) {
		t.Fatal("удачное восстановление вернуло ошибку")
	}
}
