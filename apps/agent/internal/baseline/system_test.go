package baseline

import "testing"

func TestParseInstalled(t *testing.T) {
	out := "containerd.io\tinstall ok installed\ndocker-ce\tinstall ok installed\ndocker.io\tunknown ok not-installed\nlinux-generic\tdeinstall ok config-files\n"
	got := parseInstalled(out)
	if len(got) != 2 || got[0] != "containerd.io" || got[1] != "docker-ce" {
		t.Fatalf("установленные: %v", got)
	}
}
