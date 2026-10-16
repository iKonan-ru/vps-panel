package baseline

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"os"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/fsutil"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/sshd"
)

// RootKeysPath - ключи root; панель управляет только ими.
const RootKeysPath = "/root/.ssh/authorized_keys"

// SSHKey - ключ из authorized_keys. Узнаётся по отпечатку, как в ssh-keygen -l.
type SSHKey struct {
	Type        string `json:"type"`
	Fingerprint string `json:"fingerprint"`
	Comment     string `json:"comment"`
	Options     string `json:"options,omitempty"`
}

var reFingerprint = regexp.MustCompile(`^SHA256:[A-Za-z0-9+/]{43}$`)

type keyLine struct {
	options, typ, blob, comment, fp string
}

func isKeyType(t string) bool {
	return strings.HasPrefix(t, "ssh-") || strings.HasPrefix(t, "ecdsa-sha2-") || strings.HasPrefix(t, "sk-")
}

// parseKeyLine разбирает строку authorized_keys: [опции] тип ключ [комментарий]. Опции могут
// содержать пробелы в кавычках (command="..."). Пустая строка, комментарий и мусор - ok=false.
func parseKeyLine(line string) (keyLine, bool) {
	s := strings.TrimSpace(line)
	if s == "" || strings.HasPrefix(s, "#") {
		return keyLine{}, false
	}
	var k keyLine
	if f := strings.Fields(s); !isKeyType(f[0]) {
		inQuote, i := false, 0
		for ; i < len(s); i++ {
			if c := s[i]; c == '"' {
				inQuote = !inQuote
			} else if (c == ' ' || c == '\t') && !inQuote {
				break
			}
		}
		k.options, s = s[:i], strings.TrimSpace(s[i:])
	}
	f := strings.Fields(s)
	if len(f) < 2 || !isKeyType(f[0]) {
		return keyLine{}, false
	}
	blob, err := base64.StdEncoding.DecodeString(f[1])
	if err != nil || len(blob) == 0 {
		return keyLine{}, false
	}
	sum := sha256.Sum256(blob)
	k.typ, k.blob = f[0], f[1]
	k.fp = "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
	k.comment = strings.Join(f[2:], " ")
	return k, true
}

func (k keyLine) String() string {
	parts := []string{k.typ, k.blob}
	if k.options != "" {
		parts = append([]string{k.options}, parts...)
	}
	if k.comment != "" {
		parts = append(parts, k.comment)
	}
	return strings.Join(parts, " ")
}

func readKeyLines(path string) ([]string, error) {
	b, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return strings.Split(strings.TrimRight(string(b), "\n"), "\n"), nil
}

// listKeys - ключи файла по порядку; строки-комментарии и мусор пропускаются.
func listKeys(path string) ([]SSHKey, error) {
	lines, err := readKeyLines(path)
	if err != nil {
		return nil, err
	}
	out := []SSHKey{}
	for _, l := range lines {
		if k, ok := parseKeyLine(l); ok {
			out = append(out, SSHKey{Type: k.typ, Fingerprint: k.fp, Comment: k.comment, Options: k.options})
		}
	}
	return out, nil
}

// writeKeyLines пишет файл атомарно, прежний - в .vps-panel.bak.
func writeKeyLines(path string, lines []string) error {
	if old, err := os.ReadFile(path); err == nil {
		if err := fsutil.WriteAtomic(path+".vps-panel.bak", old, 0o600); err != nil {
			return err
		}
	}
	text := strings.Join(lines, "\n")
	if text != "" {
		text += "\n"
	}
	return fsutil.WriteAtomic(path, []byte(text), 0o600)
}

// removeKey убирает все строки с этим отпечатком. Последний ключ без входа по паролю не
// удаляется: по SSH было бы не войти.
func removeKey(path, fp string, passwordLogin bool) error {
	lines, err := readKeyLines(path)
	if err != nil {
		return err
	}
	var keep []string
	found, left := false, 0
	for _, l := range lines {
		k, ok := parseKeyLine(l)
		if ok && k.fp == fp {
			found = true
			continue
		}
		if ok {
			left++
		}
		keep = append(keep, l)
	}
	if !found {
		return errors.New("ключ не найден")
	}
	if left == 0 && !passwordLogin {
		return errors.New("это последний ключ root, а вход по паролю выключен: без него по SSH не войти")
	}
	return writeKeyLines(path, keep)
}

// setKeyComment меняет комментарий (третье поле) у строк с этим отпечатком; пустой - убрать.
func setKeyComment(path, fp, comment string) error {
	comment = strings.TrimSpace(comment)
	if utf8.RuneCountInString(comment) > 200 || strings.IndexFunc(comment, unicode.IsControl) >= 0 {
		return errors.New("комментарий: до 200 символов, без управляющих")
	}
	lines, err := readKeyLines(path)
	if err != nil {
		return err
	}
	found := false
	for i, l := range lines {
		if k, ok := parseKeyLine(l); ok && k.fp == fp {
			k.comment = strings.Join(strings.Fields(comment), " ")
			lines[i] = k.String()
			found = true
		}
	}
	if !found {
		return errors.New("ключ не найден")
	}
	return writeKeyLines(path, lines)
}

// RootPasswordLogin - может ли root войти по паролю: пароли включены и PermitRootLogin yes.
// Если sshd -T ничего не сказал, считаем, что не может.
func RootPasswordLogin(ctx context.Context) bool {
	cfg := sshd.Config(ctx)
	return cfg["passwordauthentication"] == "yes" && cfg["permitrootlogin"] == "yes"
}

// CountRootKeys - число настоящих ключей root (тем же разбором, что список): мусорная строка
// ключом не считается, иначе эталон отключил бы пароли без единого рабочего ключа.
func CountRootKeys() int {
	keys, _ := listKeys(RootKeysPath)
	return len(keys)
}

// ListRootKeys - ключи root и можно ли root войти по паролю.
func ListRootKeys(ctx context.Context) (map[string]any, error) {
	keys, err := listKeys(RootKeysPath)
	if err != nil {
		return nil, err
	}
	return map[string]any{"keys": keys, "passwordLogin": RootPasswordLogin(ctx)}, nil
}

// RemoveRootKey удаляет ключ root по отпечатку.
func RemoveRootKey(ctx context.Context, fp string) error {
	if !reFingerprint.MatchString(fp) {
		return errors.New("неверный отпечаток ключа")
	}
	return removeKey(RootKeysPath, fp, RootPasswordLogin(ctx))
}

// SetRootKeyComment меняет комментарий ключа root.
func SetRootKeyComment(fp, comment string) error {
	if !reFingerprint.MatchString(fp) {
		return errors.New("неверный отпечаток ключа")
	}
	return setKeyComment(RootKeysPath, fp, comment)
}
