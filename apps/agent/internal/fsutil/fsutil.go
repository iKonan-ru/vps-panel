// Package fsutil - запись файлов целиком и контрольные суммы.
package fsutil

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
)

// Owner - владелец нового файла; Keep - не менять (root, от которого работает агент).
type Owner struct{ UID, GID int }

// Keep - владелец не меняется.
var Keep = Owner{-1, -1}

// WriteAtomic пишет файл через временный рядом и rename: читатель (sshd, systemd, port-sync)
// видит либо прежнее содержимое, либо новое целиком, а не половину.
func WriteAtomic(path string, data []byte, mode os.FileMode) error {
	return WriteAtomicOwned(path, data, mode, Keep)
}

// WriteAtomicOwned - WriteAtomic с владельцем нового файла. Путь-ссылка не заменяется файлом:
// пишется файл, на который она указывает.
func WriteAtomicOwned(path string, data []byte, mode os.FileMode, owner Owner) error {
	if real, err := filepath.EvalSymlinks(path); err == nil {
		path = real
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	err = fill(tmp, data, mode, owner)
	if err == nil {
		err = os.Rename(tmp.Name(), path)
	}
	if err != nil {
		os.Remove(tmp.Name())
	}
	return err
}

// fill пишет данные во временный файл и закрывает его.
func fill(f *os.File, data []byte, mode os.FileMode, owner Owner) error {
	_, err := f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil && owner != Keep {
		err = f.Chown(owner.UID, owner.GID)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

// FileSum - sha256 файла в hex.
func FileSum(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}
