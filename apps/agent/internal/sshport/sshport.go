// Package sshport - транзакционная смена SSH-порта с независимым таймером отката.
package sshport

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

//go:embed sshport.py
var script string

type Request struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}

func Call(ctx context.Context, mode string, request Request) (json.RawMessage, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return nil, err
	}
	cmd := exec.CommandContext(ctx, "python3", "-c", script, mode)
	cmd.Env = append(os.Environ(), "VPS_SSH_PORT_SOURCE="+script)
	cmd.Stdin = bytes.NewReader(body)
	var out, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &out, &stderr
	if err := cmd.Run(); err != nil {
		return nil, fmt.Errorf("порт SSH: %s", strings.TrimSpace(stderr.String()))
	}
	if !json.Valid(out.Bytes()) {
		return nil, fmt.Errorf("порт SSH: неверный ответ агента")
	}
	return json.RawMessage(out.Bytes()), nil
}
