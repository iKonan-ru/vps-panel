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

// FirstPort - первый Port из sshd -T (несколько Port он печатает по порядку), 22 по умолчанию.
func FirstPort(ctx context.Context) int {
	return ParseFirstPort(shell.Out(ctx, "sshd", "-T"))
}

// ParseFirstPort - первый Port из вывода sshd -T, 22 по умолчанию.
func ParseFirstPort(out string) int {
	for _, line := range strings.Split(out, "\n") {
		if k, v, ok := strings.Cut(line, " "); ok && strings.EqualFold(k, "port") {
			if p, err := strconv.Atoi(strings.TrimSpace(v)); err == nil {
				return p
			}
		}
	}
	return 22
}

// Ports - порты активного socket SSH или все Port из sshd -T, включая Include.
func Ports(ctx context.Context) []int {
	for _, unit := range []string{"ssh.socket", "sshd.socket"} {
		if shell.Out(ctx, "systemctl", "is-active", unit) != "active" {
			continue
		}
		var ports []int
		for _, address := range strings.Fields(shell.Out(ctx, "systemctl", "show", unit, "--property=Listen", "--value")) {
			if colon := strings.LastIndex(address, ":"); colon >= 0 {
				if port, err := strconv.Atoi(address[colon+1:]); err == nil {
					ports = append(ports, port)
				}
			}
		}
		return ports
	}
	var ports []int
	for _, line := range strings.Split(shell.Out(ctx, "sshd", "-T"), "\n") {
		if key, value, ok := strings.Cut(line, " "); ok && strings.EqualFold(key, "port") {
			if port, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
				ports = append(ports, port)
			}
		}
	}
	return ports
}
