// Package shell - запуск команд с таймаутом и стримингом вывода.
package shell

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"
)

// Out запускает команду и возвращает stdout (stderr отбрасывается), пустую строку при ошибке.
func Out(ctx context.Context, name string, args ...string) string {
	c, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	b, _ := exec.CommandContext(c, name, args...).Output()
	return strings.TrimSpace(string(b))
}

// OK возвращает true, если команда завершилась с кодом 0.
func OK(ctx context.Context, name string, args ...string) bool {
	c, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	return exec.CommandContext(c, name, args...).Run() == nil
}

// Has проверяет наличие бинарника в PATH.
func Has(name string) bool {
	_, err := exec.LookPath(name)
	return err == nil
}

// Result - итог Run.
type Result struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
}

// Run выполняет shell-команду, стримит строки через stream и возвращает итог.
// Вывод в Result ограничен 1 МБ на поток.
func Run(ctx context.Context, command string, timeout time.Duration, stream func(channel, chunk string)) (Result, error) {
	return RunEnv(ctx, command, nil, timeout, stream)
}

// RunEnv - Run с дополнительными переменными окружения (секреты лучше передавать так, а не аргументами).
func RunEnv(ctx context.Context, command string, extraEnv []string, timeout time.Duration, stream func(channel, chunk string)) (Result, error) {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	// без -l: профили root на каждом программном вызове не нужны (PATH задан в baseEnv), а их
	// вывод мог бы испортить разбор stdout
	cmd := exec.CommandContext(c, "/bin/bash", "-c", command)
	cmd.Env = append(BaseEnv(cmd), extraEnv...)
	return RunCmd(c, cmd, stream)
}

// Exec запускает программу с аргументами напрямую, без оболочки: значения от пользователя
// (метки, ключи настроек) не проходят через bash и не могут ничего "дописать".
func Exec(ctx context.Context, timeout time.Duration, stream func(channel, chunk string), name string, args ...string) (Result, error) {
	return ExecEnv(ctx, timeout, stream, nil, name, args...)
}

// ExecEnv - Exec с дополнительными переменными окружения.
func ExecEnv(ctx context.Context, timeout time.Duration, stream func(channel, chunk string), extraEnv []string, name string, args ...string) (Result, error) {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(c, name, args...)
	cmd.Env = append(BaseEnv(cmd), extraEnv...)
	return RunCmd(c, cmd, stream)
}

// ExecInput - Exec с данными на stdin (содержимое файла для записи внутрь контейнера).
func ExecInput(ctx context.Context, timeout time.Duration, input string, name string, args ...string) (Result, error) {
	c, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(c, name, args...)
	cmd.Env = BaseEnv(cmd)
	cmd.Stdin = strings.NewReader(input)
	return RunCmd(c, cmd, nil)
}

// BaseEnv - окружение команд агента. У systemd-службы нет HOME: acme.sh и прочие ушли бы в
// /.acme.sh; при дублях exec берёт последнее.
func BaseEnv(cmd *exec.Cmd) []string {
	return append(cmd.Environ(), "DEBIAN_FRONTEND=noninteractive", "LANG=C.UTF-8", "HOME=/root",
		"PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
}

// RunCmd запускает подготовленную команду (окружение и stdin задал вызывающий, таймаут - в c):
// своя группа процессов, строки вывода - в stream, итог с кодом выхода (убит сигналом - 128+N,
// как $? в bash).
func RunCmd(c context.Context, cmd *exec.Cmd, stream func(channel, chunk string)) (Result, error) {
	// Своя группа процессов: по таймауту убиваем всё дерево. Если убить только bash, его
	// потомки держат трубы вывода, и вызов висит до их конца, сколько бы ни был таймаут.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error { return syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL) }
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return Result{ExitCode: -1}, err
	}
	if err := cmd.Start(); err != nil {
		return Result{ExitCode: -1}, err
	}
	var outBuf, errBuf bytes.Buffer
	done := make(chan struct{}, 2)
	pump := func(r io.Reader, ch string, buf *bytes.Buffer) {
		sc := bufio.NewScanner(r)
		sc.Buffer(make([]byte, 64*1024), 1024*1024)
		for sc.Scan() {
			line := sc.Text() + "\n"
			if buf.Len() < 1<<20 {
				buf.WriteString(line)
			}
			if stream != nil {
				stream(ch, line)
			}
		}
		done <- struct{}{}
	}
	go pump(stdout, "stdout", &outBuf)
	go pump(stderr, "stderr", &errBuf)
	for n := 0; n < 2; {
		select {
		case <-done:
			n++
		case <-c.Done():
			// таймаут: группа убита; вывод может держать потомок, ушедший из группы (setsid) -
			// ждём недолго, дальше Wait закроет трубы
			select {
			case <-done:
				n++
			case <-time.After(5 * time.Second):
				n = 2
			}
		}
	}
	err = cmd.Wait()
	code := 0
	if ee, ok := err.(*exec.ExitError); ok {
		code = ee.ExitCode()
		if ws, ok := ee.Sys().(syscall.WaitStatus); ok && ws.Signaled() {
			code = 128 + int(ws.Signal())
			// Убит сигналом: чаще всего OOM-killer (нехватка памяти), таймаут или отмена.
			msg := fmt.Sprintf("процесс убит сигналом %s", ws.Signal())
			if errors.Is(c.Err(), context.DeadlineExceeded) {
				msg += " (превышен таймаут)"
			} else if c.Err() != nil {
				msg += " (остановлен)"
			} else if ws.Signal() == syscall.SIGKILL {
				msg += " (скорее всего нехватка памяти, смотри journalctl -k | grep -i oom)"
			}
			errBuf.WriteString(msg + "\n")
			if stream != nil {
				stream("stderr", msg+"\n")
			}
		}
	} else if err != nil {
		code = -1
	}
	return Result{ExitCode: code, Stdout: outBuf.String(), Stderr: errBuf.String()}, nil
}

var plainArg = regexp.MustCompile(`^[A-Za-z0-9_./:@=-]+$`)

// Quote - аргумент для строки bash: простой остаётся как есть, прочий - в одинарных кавычках.
func Quote(s string) string {
	if plainArg.MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
