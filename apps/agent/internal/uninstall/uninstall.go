// Package uninstall - общий исполнитель полной очистки для панели и SSH-команды.
package uninstall

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

//go:embed uninstall.py
var script string

// Request передаётся через stdin: пароль никогда не попадает в командную строку.
type Request struct {
	Revision   string   `json:"revision"`
	IDs        []string `json:"ids"`
	Password   string   `json:"password,omitempty"`
	Remote     bool     `json:"remote"`
	DetachOnly bool     `json:"detachOnly,omitempty"`
}

func command(ctx context.Context, mode string, extra ...string) *exec.Cmd {
	args := append([]string{"-u", "-c", script, mode}, extra...)
	cmd := exec.CommandContext(ctx, "python3", args...)
	cmd.Env = append(os.Environ(), "VPS_UNINSTALL_SOURCE="+script)
	return cmd
}

func call(ctx context.Context, mode string, body any, extra ...string) (json.RawMessage, error) {
	cmd := command(ctx, mode, extra...)
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		cmd.Stdin = bytes.NewReader(b)
	}
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		message := strings.TrimSpace(stderr.String())
		if message == "" {
			message = "нужны python3 и работающий systemd: " + err.Error()
		}
		return nil, fmt.Errorf("очистка: %s", message)
	}
	if mode == "cancel" {
		return json.RawMessage(`{"ok":true}`), nil
	}
	if !json.Valid(out.Bytes()) {
		return nil, fmt.Errorf("очистка: неверный ответ проверки")
	}
	return json.RawMessage(out.Bytes()), nil
}

func Scan(ctx context.Context) (json.RawMessage, error) { return call(ctx, "scan", nil) }

func Validate(ctx context.Context, p Request) (json.RawMessage, error) {
	p.Remote = true
	return call(ctx, "validate", p)
}

func Prepare(ctx context.Context, p Request) (json.RawMessage, error) {
	p.Remote = true
	return call(ctx, "prepare", p)
}

func Cancel(ctx context.Context, token string) (json.RawMessage, error) {
	return call(ctx, "cancel", nil, token)
}

// CLI работает вне службы агента: удаление службы не прерывает SSH и саму очистку.
func CLI(mode, panelRoot, token string) int {
	cmd := command(context.Background(), mode)
	if mode == "cancel" {
		cmd = command(context.Background(), mode, token)
	}
	if panelRoot != "" {
		cmd.Env = append(cmd.Env, "VPS_PANEL_ROOT="+panelRoot)
	}
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		fmt.Fprintln(os.Stderr, "vps-agent: очистка не завершена:", err)
		return 1
	}
	return 0
}
