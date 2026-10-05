package services

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// XrayStatus - состояние ядра xray у 3X-UI: inbound на занятом порту роняет весь xray, а 3X-UI
// перезапускает его каждые 2 с - VLESS сервера не работает, хотя 3X-UI запущена.
type XrayStatus struct {
	Running  bool   // процесс xray 3X-UI есть
	Failures int    // ошибок запуска в журнале x-ui за 3 минуты
	Error    string // текст последней из них
}

// xrayFailLoop - столько ошибок запуска за 3 минуты считаем перезапуском по кругу: процесс
// может оказаться живым в момент проверки, но работать не успевает.
const xrayFailLoop = 3

// Down - VLESS сервера не работает: xray не запущен или падает по кругу.
func (s XrayStatus) Down() bool { return !s.Running || s.Failures >= xrayFailLoop }

// XuiInstalled - есть ли 3X-UI на хосте (быстрая проверка без чтения базы).
func XuiInstalled() bool {
	for _, p := range []string{"/usr/local/x-ui", "/etc/x-ui/x-ui.db"} {
		if _, err := os.Stat(p); err == nil {
			return true
		}
	}
	return false
}

// XrayState проверяет процесс и журнал. Процесс 3X-UI называется xray-linux-<arch> (в comm
// обрезан до 15 символов); у VPS Panel свой xray с именем xray - его не путаем.
func XrayState(ctx context.Context) XrayStatus {
	st := XrayStatus{Running: xrayProcess("/proc")}
	// установка в docker журнала x-ui не имеет - тогда только процесс
	out := shell.Out(ctx, "journalctl", "-u", "x-ui", "--since", "-3min", "--no-pager", "-o", "cat")
	for _, line := range strings.Split(out, "\n") {
		if _, msg, ok := strings.Cut(line, "Failed to start: "); ok {
			st.Failures++
			st.Error = trimXrayError(msg)
		}
	}
	return st
}

func xrayProcess(proc string) bool {
	comms, _ := filepath.Glob(filepath.Join(proc, "[0-9]*", "comm"))
	for _, f := range comms {
		b, err := os.ReadFile(f)
		if err == nil && strings.HasPrefix(strings.TrimSpace(string(b)), "xray-linux") {
			return true
		}
	}
	return false
}

// trimXrayError: "app/proxyman/inbound: failed to listen TCP on 443 > transport/internet: ..."
// - первые два звена цепочки, не длиннее 200 символов.
func trimXrayError(msg string) string {
	parts := strings.Split(strings.TrimSpace(msg), " > ")
	if len(parts) > 2 {
		parts = parts[:2]
	}
	s := strings.Join(parts, " > ")
	if len(s) > 200 {
		s = s[:200]
	}
	return s
}
