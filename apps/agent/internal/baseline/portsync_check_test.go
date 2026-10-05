package baseline

import "testing"

func TestCheckPortsyncConfig(t *testing.T) {
	ok := DefaultPortsyncConfig()
	ok.AdminIPs = []string{"1.2.3.4", "10.0.0.0/8", "2001:db8::1"}
	ok.ExtraAllow = []string{"443", "8443/tcp", "51820/udp"}
	ok.WanInterface = "eth0"
	if err := CheckPortsyncConfig(ok); err != nil {
		t.Fatal(err)
	}
	bad := []func(c *PortsyncConfig){
		func(c *PortsyncConfig) { c.AdminIPs = []string{"1.2.3.4; rm -rf /"} },
		func(c *PortsyncConfig) { c.ExtraAllow = []string{"443/sctp"} },
		func(c *PortsyncConfig) { c.DenyPublicPorts = []string{"70000"} },
		func(c *PortsyncConfig) { c.KnownProcesses = []string{"a b"} },
		func(c *PortsyncConfig) { c.WanInterface = "lo" },
		func(c *PortsyncConfig) { c.DockerPolicy = "all" },
		func(c *PortsyncConfig) { c.SSHPort = 99999 },
	}
	for i, f := range bad {
		c := DefaultPortsyncConfig()
		f(&c)
		if CheckPortsyncConfig(c) == nil {
			t.Errorf("случай %d должен отклоняться", i)
		}
	}
}
