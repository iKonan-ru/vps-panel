package adapters

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWdttPorts(t *testing.T) {
	dir := t.TempDir()
	wdttUnit = filepath.Join(dir, "wdtt.service")
	unit := "[Service]\nExecStart=/usr/local/bin/wdtt-server -listen 0.0.0.0:56000 -wg-port 56001 -config-dir /etc/wdtt " +
		"-admin-listen 127.0.0.1:56002 -admin-token-file /etc/wdtt/admin.token -listen-direct 0.0.0.0:56003 -listen-raw 0.0.0.0:56004\n"
	if err := os.WriteFile(wdttUnit, []byte(unit), 0o600); err != nil {
		t.Fatal(err)
	}
	dtls, admin, wg, err := WdttPorts()
	if err != nil || dtls != 56000 || admin != 56002 || wg != 56001 {
		t.Fatalf("got %d %d %d %v", dtls, admin, wg, err)
	}
	// без -admin-listen admin API выключен
	_ = os.WriteFile(wdttUnit, []byte("ExecStart=/usr/local/bin/wdtt-server -listen 0.0.0.0:56000\n"), 0o600)
	if _, _, _, err := WdttPorts(); err == nil {
		t.Fatal("ждали ошибку без -admin-listen")
	}
}

func TestWdttAPIRejectsUnknownPathAndMethod(t *testing.T) {
	if _, err := WdttAPI(context.Background(), WdttAPIRequest{Path: "/admin/other"}); err == nil {
		t.Fatal("путь не из белого списка должен отвергаться")
	}
	if _, err := WdttAPI(context.Background(), WdttAPIRequest{Method: "DELETE", Path: "/admin/passwords"}); err == nil {
		t.Fatal("метод DELETE должен отвергаться")
	}
}

// Ошибка сети не выносит токен бота наружу (в *url.Error - полный адрес).
func TestTelegramErrorHidesToken(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := telegramCall(ctx, "123456:SECRETTOKENSECRETTOKENSECRETTOKEN", "sendMessage", nil)
	if err == nil || strings.Contains(err.Error(), "SECRETTOKEN") {
		t.Fatalf("ошибка с токеном или без ошибки: %v", err)
	}
}
