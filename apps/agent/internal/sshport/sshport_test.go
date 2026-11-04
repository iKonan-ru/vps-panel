package sshport

import (
	"os/exec"
	"testing"
)

func TestPortChangeScenarios(t *testing.T) {
	cmd := exec.Command("python3", "-m", "unittest", "discover", "-p", "sshport_test.py")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("смена SSH-порта: %v\n%s", err, output)
	}
}
