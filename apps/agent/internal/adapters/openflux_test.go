package adapters

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMaskOfLog(t *testing.T) {
	in := "connect https://docs.yandex.ru/edit/d/AbCdEf123 ok; key " + strings.Repeat("ab", 32) + " https://cloud.mail.ru/public/Ab/Cd"
	got := MaskOfLog(in)
	if strings.Contains(got, "AbCdEf123") || strings.Contains(got, strings.Repeat("ab", 32)) || strings.Contains(got, "/public/Ab") {
		t.Fatalf("секрет в журнале: %q", got)
	}
	if !strings.Contains(got, "https://docs.yandex.ru/***") {
		t.Fatalf("хост пропал: %q", got)
	}
}

func TestReadOfConf(t *testing.T) {
	dir := t.TempDir()
	conf := `# OpenFlux node channel of-x, written by node-install.sh
Role = exit
Mode = l4
EncryptionKeyFile = /etc/openflux-node/of-x/encryption-key
URL = https://docs.yandex.ru/edit/d/doc1

[Transport vyandex]
Type = vyandex
Priority = 100
URL = https://docs.yandex.ru/edit/d/doc1

[Transport direct]
Type = direct
Priority = 50
Listen = 0.0.0.0:43419
`
	_ = os.MkdirAll(filepath.Join(dir, "of-x"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "of-x", "node.conf"), []byte(conf), 0o600)
	old := ofEtcDir
	ofEtcDir = dir
	defer func() { ofEtcDir = old }()
	c, err := readOfConf("of-x")
	if err != nil {
		t.Fatal(err)
	}
	if c.context != "https://docs.yandex.ru/edit/d/doc1" || len(c.transports) != 2 {
		t.Fatalf("%+v", c)
	}
	if c.transports[0].Type != "vyandex" || c.transports[0].Priority != 100 || c.transports[0].url == "" {
		t.Fatalf("vyandex: %+v", c.transports[0])
	}
	if c.transports[1].Type != "direct" || c.transports[1].listen != "0.0.0.0:43419" {
		t.Fatalf("direct: %+v", c.transports[1])
	}
}

func TestOfValidation(t *testing.T) {
	for _, bad := range []string{"-x", "Of-x", "a b", strings.Repeat("a", 32), "a\nb"} {
		if reOfChannel.MatchString(bad) {
			t.Errorf("имя %q принято", bad)
		}
	}
	if reOfYandex.MatchString("https://docs.yandex.ru/edit/d/x\nkey=1") || !reOfYandex.MatchString("https://docs.yandex.ru/edit/d/AbCdEfGh-1_2345678") {
		t.Fatal("проверка ссылки Яндекса")
	}
}

func TestOfNodeConfRoundTrip(t *testing.T) {
	dir := t.TempDir()
	old := ofEtcDir
	ofEtcDir = dir
	defer func() { ofEtcDir = old }()
	_ = os.MkdirAll(filepath.Join(dir, "vp-x"), 0o755)
	conf := ofNodeConf("vp-x", 43419, "", "https://cloud.mail.ru/public/Ab/Cd", "eyJhIjoxfQ")
	_ = os.WriteFile(filepath.Join(dir, "vp-x", "node.conf"), []byte(conf), 0o600)
	c, err := readOfConf("vp-x")
	if err != nil {
		t.Fatal(err)
	}
	// контекст - документ Mail.ru (Яндекса нет), транспорты по приоритету, direct с портом
	if c.context != "https://cloud.mail.ru/public/Ab/Cd" || len(c.transports) != 3 {
		t.Fatalf("%+v", c)
	}
	if c.transports[0].Type != "mailru" || c.transports[1].Type != "cupsonline" || c.transports[1].url != "eyJhIjoxfQ" || c.transports[2].listen != "0.0.0.0:43419" {
		t.Fatalf("%+v", c.transports)
	}
	if !strings.Contains(conf, "EncryptionKeyFile = "+dir+"/vp-x/encryption-key") {
		t.Fatal("путь ключа")
	}
}

func TestOfCheckTransports(t *testing.T) {
	if ofCheckTransports(OfRequest{Cupsonline: "keep"}, false) == nil {
		t.Fatal("keep при создании канала")
	}
	if ofCheckTransports(OfRequest{Cupsonline: "keep"}, true) != nil || ofCheckTransports(OfRequest{Cupsonline: "auto"}, false) != nil {
		t.Fatal("auto и keep при перенастройке")
	}
	if ofCheckTransports(OfRequest{Mailru: "https://cloud.mail.ru/public/Ab/Cd\nRole = client"}, true) == nil {
		t.Fatal("перевод строки в ссылке")
	}
}

// OpenFlux без копии установщика (мастер приложения, старая версия) - всё равно установлен:
// по каналам в /etc/openflux-node.
func TestOfInstalledByChannels(t *testing.T) {
	old := ofEtcDir
	defer func() { ofEtcDir = old }()
	ofEtcDir = t.TempDir()
	if _, err := os.Stat(ofInstaller); err == nil {
		t.Skip("на машине стоит OpenFlux")
	}
	if ofInstalled() {
		t.Fatal("пустой каталог каналов - не установлен")
	}
	if err := os.Mkdir(filepath.Join(ofEtcDir, "main"), 0o700); err != nil {
		t.Fatal(err)
	}
	if !ofInstalled() {
		t.Fatal("есть канал - установлен")
	}
}
