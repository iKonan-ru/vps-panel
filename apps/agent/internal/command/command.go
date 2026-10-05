// Package command выполняет команды каталога панели: скрипт bash с переменными
// окружения и вспомогательными файлами, с возможностью отмены.
package command

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Params - запрос панели.
type Params struct {
	// RunID - идентификатор запуска (для отмены).
	RunID string `json:"runId"`
	// Script - тело bash-скрипта.
	Script string `json:"script"`
	// Env - переменные окружения (ответы на вопросы; секреты сюда тоже - в ps они не видны).
	Env map[string]string `json:"env"`
	// Files - файлы, которые нужно положить до запуска: путь -> содержимое. Права 0600.
	Files map[string]string `json:"files"`
	// TimeoutSec - предел времени, по умолчанию 30 минут.
	TimeoutSec int `json:"timeoutSec"`
	// Cleanup - файлы, которые удалить после завершения (секреты).
	Cleanup []string `json:"cleanup"`
}

type Result struct {
	ExitCode int    `json:"exitCode"`
	Tail     string `json:"tail"`
	Killed   bool   `json:"killed"`
}

var (
	mu      sync.Mutex
	running = map[string]context.CancelFunc{}
)

// Cancel останавливает запуск по RunID. Возвращает false, если такого нет.
func Cancel(runID string) bool {
	mu.Lock()
	defer mu.Unlock()
	c, ok := running[runID]
	if ok {
		c()
	}
	return ok
}

// Run выполняет скрипт. Вывод стримится построчно в stream (канал "stdout"/"stderr").
func Run(ctx context.Context, p Params, stream func(channel, chunk string)) (Result, error) {
	if p.Script == "" {
		return Result{ExitCode: -1}, errors.New("пустой скрипт")
	}
	timeout := time.Duration(p.TimeoutSec) * time.Second
	if timeout <= 0 || timeout > 4*time.Hour {
		timeout = 30 * time.Minute
	}
	for path, content := range p.Files {
		if !filepath.IsAbs(path) {
			return Result{ExitCode: -1}, fmt.Errorf("путь файла должен быть абсолютным: %s", path)
		}
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return Result{ExitCode: -1}, err
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			return Result{ExitCode: -1}, fmt.Errorf("запись %s: %w", path, err)
		}
		// WriteFile не меняет права уже существующего файла, а в нём секрет
		if err := os.Chmod(path, 0o600); err != nil {
			return Result{ExitCode: -1}, err
		}
	}
	defer func() {
		for _, f := range p.Cleanup {
			_ = os.Remove(f)
		}
	}()

	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	killed := false
	if p.RunID != "" {
		mu.Lock()
		running[p.RunID] = func() {
			killed = true
			cancel()
		}
		mu.Unlock()
		defer func() {
			mu.Lock()
			delete(running, p.RunID)
			mu.Unlock()
		}()
	}

	cmd := exec.CommandContext(c, "/bin/bash", "-c", p.Script)
	cmd.Env = append(shell.BaseEnv(cmd), "TERM=dumb")
	for k, v := range p.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	// хвост - stdout и stderr вместе, в порядке вывода: по нему панель разбирает итог проверок
	var tail strings.Builder
	var tailMu sync.Mutex
	res, err := shell.RunCmd(c, cmd, func(ch, line string) {
		tailMu.Lock()
		if tail.Len() < 256*1024 {
			tail.WriteString(line)
		}
		tailMu.Unlock()
		if stream != nil {
			stream(ch, line)
		}
	})
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	if killed {
		stream("stderr", "\n== Остановлено по запросу из панели\n")
	} else if c.Err() == context.DeadlineExceeded {
		stream("stderr", fmt.Sprintf("\n== Превышен предел времени (%s), процесс убит\n", timeout))
	}
	return Result{ExitCode: res.ExitCode, Tail: tail.String(), Killed: killed}, nil
}
