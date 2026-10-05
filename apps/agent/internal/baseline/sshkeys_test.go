package baseline

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Ключи и отпечатки - из ssh-keygen (-lf), чтобы отпечатки совпадали с тем, что видит человек.
const (
	edKey  = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIElrFHGgaeKS3hg4tYgKXVk7aNr/8FxoYku8pzw25y3+"
	edFp   = "SHA256:0vl9vSFVtARx0nMZDR2a+YMwecU+DMxxesjj3ExG6Ko"
	rsaKey = "ssh-rsa AAAAB3NzaC1yc2EAAAADAQABAAABAQC24+FATLAjAHIK947Khe7+Z1vJXgC5Q2ztZ4Ac50iJ7lQoJlePtHZh2IUTxt08Cxs/0+yiSsatSA4us5Bt/HGthHDjl2yBSL7XQKSOcpOeGDjLsUFlZ25OwuCFAiCcwad3NmVpSYfHonTm0/me079P8/2UGTURCbHpQCMInFNIl3Pz1793reca+KWD165grUerEa/FE/H1M8e6NQ2M2F6I7ftUucu3c38zvNdflsS0O0CRamSQnYEwK9WoeSVDPC6WoN90SASsuxHE18JMiPHoesD0kNq43EnkPdJn6CSXGutXABdZiJUdc72WBSd4zJGcjlKNYXx6566PyyGFOnJ9"
	rsaFp  = "SHA256:YEcVgWGsHQi/Beq0YvaGfcWwKoJ9LwdPvo5Bhn5IBJ8"
)

func TestParseKeyLine(t *testing.T) {
	k, ok := parseKeyLine(edKey + " ivan@pc  ноутбук")
	if !ok || k.fp != edFp || k.typ != "ssh-ed25519" || k.comment != "ivan@pc ноутбук" || k.options != "" {
		t.Fatalf("ed25519: %+v %v", k, ok)
	}
	k, ok = parseKeyLine(`no-pty,command="echo hi there",from="10.0.0.1" ` + rsaKey + " old rsa")
	if !ok || k.fp != rsaFp || k.options != `no-pty,command="echo hi there",from="10.0.0.1"` || k.comment != "old rsa" {
		t.Fatalf("опции с пробелами в кавычках: %+v %v", k, ok)
	}
	for _, bad := range []string{"", "   ", "# ssh-ed25519 AAAA", "ssh-ed25519", "garbage line here", "ssh-ed25519 !!!notbase64"} {
		if _, ok := parseKeyLine(bad); ok {
			t.Fatalf("принята строка %q", bad)
		}
	}
}

func writeTemp(t *testing.T, text string) string {
	t.Helper()
	p := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(p, []byte(text), 0o600); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestRemoveAndComment(t *testing.T) {
	p := writeTemp(t, "# мой комментарий\n"+edKey+" ivan@pc\n"+rsaKey+" old rsa\n")
	keys, err := listKeys(p)
	if err != nil || len(keys) != 2 || keys[1].Fingerprint != rsaFp {
		t.Fatalf("список: %+v %v", keys, err)
	}
	if err := setKeyComment(p, edFp, "  ноутбук  Ивана "); err != nil {
		t.Fatal(err)
	}
	if err := setKeyComment(p, edFp, "a\nb"); err == nil {
		t.Fatal("комментарий с переводом строки принят")
	}
	if err := removeKey(p, rsaFp, false); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(p)
	if want := "# мой комментарий\n" + edKey + " ноутбук Ивана\n"; string(b) != want {
		t.Fatalf("файл:\n%s\nждали:\n%s", b, want)
	}
	// бэкап - файл до последнего изменения: удалённый ключ в нём ещё есть
	if bak, _ := os.ReadFile(p + ".vps-panel.bak"); !strings.Contains(string(bak), "old rsa") {
		t.Fatalf("бэкап не прежний файл: %s", bak)
	}
	if st, _ := os.Stat(p); st.Mode().Perm() != 0o600 {
		t.Fatalf("права %v", st.Mode().Perm())
	}
	if err := removeKey(p, edFp, false); err == nil || !strings.Contains(err.Error(), "последний ключ") {
		t.Fatalf("последний ключ без пароля удалён: %v", err)
	}
	if err := removeKey(p, rsaFp, true); err == nil {
		t.Fatal("удалён несуществующий ключ")
	}
	if err := removeKey(p, edFp, true); err != nil {
		t.Fatalf("последний ключ при входе по паролю: %v", err)
	}
	if keys, _ := listKeys(p); len(keys) != 0 {
		t.Fatalf("остались ключи: %+v", keys)
	}
}

func TestAddKeys(t *testing.T) {
	path := filepath.Join(t.TempDir(), "authorized_keys")
	if err := os.WriteFile(path, []byte(edKey+" old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	n, err := addKeys(path, []string{edKey + " same key, other comment", `command="x" ` + edKey})
	if err != nil || n != 0 {
		t.Fatalf("дубль по отпечатку добавлен: n=%d err=%v", n, err)
	}
	for _, bad := range []string{edKey[:40] + "\n" + edKey[40:], "ssh-ed25519 !!!notbase64", "garbage"} {
		if _, err := addKeys(path, []string{bad}); err == nil {
			t.Errorf("принят битый ключ %q", bad)
		}
	}
	b, _ := os.ReadFile(path)
	if string(b) != edKey+" old\n" {
		t.Fatalf("файл изменился: %q", b)
	}
}
