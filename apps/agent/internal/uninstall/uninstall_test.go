package uninstall

import (
	"os/exec"
	"testing"
)

func TestCleanupScenarios(t *testing.T) {
	cmd := exec.Command("python3", "-m", "unittest", "discover", "-p", "uninstall_test.py")
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("сценарии полной очистки: %v\n%s", err, output)
	}
}
