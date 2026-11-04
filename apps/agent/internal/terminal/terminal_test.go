package terminal

import (
	"encoding/base64"
	"os/exec"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/creack/pty"
)

func TestCtrlCInterruptsForegroundCommand(t *testing.T) {
	cmd := exec.Command("/bin/bash", "--noprofile", "--norc", "-i")
	f, err := pty.Start(cmd)
	if err != nil {
		t.Fatal(err)
	}
	mu.Lock()
	sessions["interrupt-test"] = &session{pty: f, cmd: cmd, cancel: func() {}}
	mu.Unlock()
	defer func() { Close("interrupt-test"); _ = cmd.Wait() }()
	var output strings.Builder
	var guard sync.Mutex
	go func() {
		buf := make([]byte, 4096)
		for {
			n, err := f.Read(buf)
			if n > 0 {
				guard.Lock()
				output.Write(buf[:n])
				guard.Unlock()
			}
			if err != nil {
				return
			}
		}
	}()
	send := func(value string) {
		t.Helper()
		if err := Input("interrupt-test", base64.StdEncoding.EncodeToString([]byte(value))); err != nil {
			t.Fatal(err)
		}
	}
	wait := func(value string) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			guard.Lock()
			found := strings.Contains(output.String(), value)
			guard.Unlock()
			if found {
				return
			}
			time.Sleep(20 * time.Millisecond)
		}
		guard.Lock()
		defer guard.Unlock()
		t.Fatalf("не получено %q: %s", value, output.String())
	}
	send("stty -echo; printf 'READY\\n'\n")
	wait("READY\r\n")
	send("sleep 30\n")
	time.Sleep(150 * time.Millisecond)
	send("\x03")
	time.Sleep(50 * time.Millisecond)
	send("printf 'ALIVE:%s\\n' \"$?\"\n")
	wait("ALIVE:130\r\n")
}
