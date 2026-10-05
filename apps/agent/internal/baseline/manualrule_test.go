package baseline

import (
	"strings"
	"testing"
)

func TestManualRuleArgs(t *testing.T) {
	ok := []struct {
		r    ManualRule
		want string
	}{
		{ManualRule{ID: "a1", PortFrom: 443, Proto: "tcp"}, "allow from any to any port 443 proto tcp comment panel:a1"},
		{ManualRule{ID: "b", PortFrom: 1000, PortTo: 2000, Proto: "udp", Source: "203.0.113.0/24", Action: "deny"},
			"deny from 203.0.113.0/24 to any port 1000:2000 proto udp comment panel:b"},
		{ManualRule{ID: "c", PortFrom: 22, Source: "2001:db8::1"}, "allow from 2001:db8::1 to any port 22 comment panel:c"},
	}
	for _, c := range ok {
		a, err := c.r.args()
		if err != nil || strings.Join(a, " ") != c.want {
			t.Errorf("%+v: %q %v", c.r, strings.Join(a, " "), err)
		}
	}
	bad := []ManualRule{
		{ID: "x", PortFrom: 22, Source: "1.2.3.4; reboot"},
		{ID: "x; reboot", PortFrom: 22},
		{ID: "x", PortFrom: 0},
		{ID: "x", PortFrom: 22, Source: "example.com"},
	}
	for _, r := range bad {
		if _, err := r.args(); err == nil {
			t.Errorf("правило прошло проверку: %+v", r)
		}
	}
}
