package firewall

import "testing"

func TestParseRuleComments(t *testing.T) {
	cases := []struct {
		line, origin, comment string
	}{
		{"8443/tcp                   ALLOW       Anywhere                   # vps-portsync: 3X-UI XHTTP", "portsync", "3X-UI XHTTP"},
		{"41234/tcp                  ALLOW       Anywhere                   # vps-portsync: 3X-UI Германия :: NetCore", "portsync", "3X-UI Германия :: NetCore"},
		{"22/tcp                     ALLOW       Anywhere                   # vps-portsync", "portsync", ""},
		{"51234/tcp                  ALLOW       Anywhere                   # openflux-node of-abcdef", "manual", "openflux-node of-abcdef"},
		{"5000/tcp                   ALLOW       Anywhere                   # panel:abc", "manual", ""},
	}
	for _, c := range cases {
		r, ok := parseRule(c.line)
		if !ok || r.Origin != c.origin || r.Comment != c.comment {
			t.Errorf("%q: ok=%v origin=%q comment=%q", c.line, ok, r.Origin, r.Comment)
		}
	}
}
