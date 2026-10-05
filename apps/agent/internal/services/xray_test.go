package services

import (
	"os"
	"path/filepath"
	"testing"
)

func TestXrayProcess(t *testing.T) {
	dir := t.TempDir()
	write := func(pid, comm string) {
		_ = os.MkdirAll(filepath.Join(dir, pid), 0o755)
		_ = os.WriteFile(filepath.Join(dir, pid, "comm"), []byte(comm+"\n"), 0o644)
	}
	write("10", "sshd")
	write("11", "xray") // xray VPS Panel - не 3X-UI
	if xrayProcess(dir) {
		t.Fatal("xray панели принят за xray 3X-UI")
	}
	write("12", "xray-linux-amd6")
	if !xrayProcess(dir) {
		t.Fatal("xray 3X-UI не найден")
	}
}

func TestXrayDown(t *testing.T) {
	if !(XrayStatus{Running: false}).Down() {
		t.Fatal("не запущен - не работает")
	}
	if !(XrayStatus{Running: true, Failures: 5}).Down() {
		t.Fatal("падает по кругу - не работает")
	}
	if (XrayStatus{Running: true, Failures: 1}).Down() {
		t.Fatal("одна ошибка при живом процессе - ещё не авария")
	}
}

func TestTrimXrayError(t *testing.T) {
	got := trimXrayError("app/proxyman/inbound: failed to listen TCP on 443 > transport/internet: failed to listen on address: 0.0.0.0:443 > transport/internet/splithttp: failed")
	want := "app/proxyman/inbound: failed to listen TCP on 443 > transport/internet: failed to listen on address: 0.0.0.0:443"
	if got != want {
		t.Fatalf("got %q", got)
	}
}
