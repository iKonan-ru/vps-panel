// Package sshd - действующие настройки sshd (sshd -T): общее для аудита, эталона и ключей root.
package sshd

import (
	"context"
	"strconv"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Config - вывод sshd -T, ключи в нижнем регистре. Пусто, если sshd -T не отработал.
func Config(ctx context.Context) map[string]string {
	cfg := map[string]string{}
	for _, line := range strings.Split(shell.Out(ctx, "sshd", "-T"), "\n") {
		if k, v, ok := strings.Cut(line, " "); ok {
			cfg[strings.ToLower(k)] = v
		}
	}
	return cfg
}

// Port - порт SSH из настроек, 22 по умолчанию.
func Port(cfg map[string]string) int {
	if p, err := strconv.Atoi(cfg["port"]); err == nil {
		return p
	}
	return 22
}
