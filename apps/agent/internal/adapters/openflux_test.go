package adapters

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
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
	ok := OfRequest{
		Telemost: "https://telemost.yandex.ru/j/12345678901234",
		Boards:   "https://boards.yandex.ru/whiteboard/?hash=0123456789abcdef0123456789abcdef",
		Avito:    "auto",
	}
	if err := ofCheckTransports(ok, false); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []OfRequest{
		{Telemost: "https://telemost.yandex.ru/j/abc"},
		{Boards: "https://boards.yandex.ru/whiteboard/?hash=xyz"},
		{Avito: "keep"},
		{Avito: "ab\ncd=1234"},
	} {
		if ofCheckTransports(bad, false) == nil {
			t.Fatalf("принято: %+v", bad)
		}
	}
}

func TestOfTransportLines(t *testing.T) {
	got := ofTransportLines(OfRequest{Mailru: "m", Telemost: "t", Avito: "a", Cupsonline: "c"})
	want := []string{"mailru=m", "telemost=t", "avito=a", "cupsonline=c"}
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("%v", got)
	}
	if ofTransportLines(OfRequest{}) != nil {
		t.Fatal("пустой канал")
	}
}

func TestOfAutoRooms(t *testing.T) {
	made := func(context.Context, func(string)) (string, error) { return "new", nil }
	failed := func(context.Context, func(string)) (string, error) { return "", errors.New("429") }
	log := func(string) {}
	if ofAutoRooms(context.Background(), log, "keep", "cur", made, "x") != "cur" ||
		ofAutoRooms(context.Background(), log, "auto", "cur", made, "x") != "new" ||
		ofAutoRooms(context.Background(), log, "auto", "cur", failed, "x") != "" ||
		ofAutoRooms(context.Background(), log, "", "cur", made, "x") != "" {
		t.Fatal("keep, auto, сбой, пусто")
	}
}

// Комнаты Avito: POST на /web/1/code/room, список v2 (чётное число), ограничение частоты -
// понятная ошибка, если не создалось ни одной пары.
func TestOfAvitoRooms(t *testing.T) {
	n := 0
	limit := 3
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/web/1/code/room" || r.Header.Get("Origin") == "" {
			w.WriteHeader(400)
			return
		}
		n++
		if n > limit {
			w.WriteHeader(429)
			return
		}
		fmt.Fprintf(w, `{"room":{"id":"room-%d"}}`, n)
	}))
	defer srv.Close()
	old := ofAvitoRoomsBase
	ofAvitoRoomsBase = srv.URL
	defer func() { ofAvitoRoomsBase = old }()

	packed, err := ofAvitoRooms(context.Background(), func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := base64.RawURLEncoding.DecodeString(packed)
	var v struct {
		V     int      `json:"v"`
		Rooms []string `json:"rooms"`
	}
	if json.Unmarshal(raw, &v) != nil || v.V != 2 || strings.Join(v.Rooms, ",") != "room-1,room-2" {
		t.Fatalf("%s", raw)
	}
	n, limit = 0, 0
	if _, err := ofAvitoRooms(context.Background(), func(string) {}); err == nil || !strings.Contains(err.Error(), "ограничение частоты") {
		t.Fatalf("%v", err)
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
