package backup

import (
	"archive/tar"
	"compress/gzip"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// Потолки распаковки бэкапа: архив подменить без панели нельзя (sha256 обязателен), но и
// битый архив не должен заполнить диск.
const (
	maxUntarBytes   = 16 << 30
	maxUntarEntries = 500_000
)

// extractTarGz распаковывает архив бэкапа в dst своим кодом вместо tar от root:
// имена только внутри dst (без "..", абсолютных путей), запись никогда не идёт через
// символическую ссылку из того же архива, жёсткие ссылки и устройства пропускаются, биты
// setuid/setgid/sticky снимаются. Владелец сохраняется - так файлы лежали на сервере.
func extractTarGz(archive, dst string, log func(string, ...any)) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	zr, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("архив: %w", err)
	}
	defer zr.Close()
	root, err := filepath.Abs(dst)
	if err != nil {
		return err
	}
	tr := tar.NewReader(zr)
	var total int64
	for n := 0; ; n++ {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("архив: %w", err)
		}
		if n >= maxUntarEntries {
			return errors.New("в архиве слишком много файлов")
		}
		name := filepath.Clean("/" + hdr.Name) // абсолютный и ".." не выходят за корень
		if name == "/" {
			continue
		}
		target := filepath.Join(root, name)
		if err := noLinkInPath(root, filepath.Dir(target)); err != nil {
			return fmt.Errorf("архив: %s: %w", hdr.Name, err)
		}
		mode := os.FileMode(hdr.Mode) & 0o777
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			if err := os.Chmod(target, mode|0o700); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			total += hdr.Size
			if total > maxUntarBytes {
				return errors.New("архив распаковывается больше 16 ГБ")
			}
			// O_EXCL: файл не появится через ссылку, оставленную на его месте
			_ = os.Remove(target)
			out, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, mode)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, io.LimitReader(tr, hdr.Size))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		case tar.TypeSymlink:
			if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
				return err
			}
			_ = os.Remove(target)
			if err := os.Symlink(hdr.Linkname, target); err != nil {
				return err
			}
		default:
			log("  пропущено (жёсткая ссылка или устройство): %s", hdr.Name)
			continue
		}
		_ = os.Lchown(target, hdr.Uid, hdr.Gid)
	}
}

// noLinkInPath - ни один каталог от root до dir не символическая ссылка (созданная раньше
// записью того же архива): иначе следующая запись ушла бы за пределы распаковки.
func noLinkInPath(root, dir string) error {
	rel, err := filepath.Rel(root, dir)
	if err != nil || rel == ".." || strings.HasPrefix(rel, "../") {
		return errors.New("путь за пределами распаковки")
	}
	cur := root
	for _, part := range strings.Split(rel, string(filepath.Separator)) {
		if part == "." || part == "" {
			continue
		}
		cur = filepath.Join(cur, part)
		st, err := os.Lstat(cur)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return errors.New("запись через символическую ссылку")
		}
	}
	return nil
}
