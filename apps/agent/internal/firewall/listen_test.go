package firewall

import (
	"slices"
	"testing"
)

func TestParseSockets(t *testing.T) {
	out := `tcp   LISTEN 0 4096 127.0.0.1:56002 0.0.0.0:* users:(("wdtt-server",pid=10,fd=7))
udp   UNCONN 0 0    0.0.0.0:56000   0.0.0.0:* users:(("wdtt-server",pid=10,fd=5))
tcp   LISTEN 0 511  [::]:443        [::]:*    users:(("nginx",pid=1,fd=6),("nginx",pid=2,fd=6))
udp   UNCONN 0 0    0.0.0.0:68      0.0.0.0:* users:(("dhclient",pid=3,fd=6))`
	got := parseSockets(out)
	if len(got) != 4 || got[0].addr != "127.0.0.1" || got[0].port != 56002 || !slices.Equal(got[2].procs, []string{"nginx", "nginx"}) {
		t.Fatalf("%+v", got)
	}
}

func TestPublicTCPPorts(t *testing.T) {
	out := `tcp LISTEN 0 4096 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=1,fd=3))
tcp LISTEN 0 4096 *:443 *:* users:(("xray",pid=2,fd=4))
tcp LISTEN 0 4096 127.0.0.1:2053 0.0.0.0:* users:(("x-ui",pid=3,fd=5))
udp UNCONN 0 0 0.0.0.0:51820 0.0.0.0:*`
	got := publicTCPPorts(parseSockets(out), []string{"sshd"})
	if len(got) != 1 || !got[443] {
		t.Errorf("порты %v, ждали только 443", got)
	}
}
