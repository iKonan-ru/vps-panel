package baseline

import (
	"slices"
	"testing"
)

func TestDefaultDev(t *testing.T) {
	cases := map[string]string{
		"default via 203.0.113.1 dev eth0 proto static \n":                         "eth0",
		"default via 198.51.100.1 dev ens3 proto dhcp src 198.51.100.7 metric 100": "ens3",
		"10.66.0.0/16 dev wdtt0 proto kernel scope link src 10.66.66.1\n":          "",
		"": "",
	}
	for in, want := range cases {
		if got := defaultDev(in); got != want {
			t.Errorf("defaultDev(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestInetAddrs(t *testing.T) {
	out := "2: eth0    inet 203.0.113.10/24 brd 203.0.113.255 scope global eth0\\       valid_lft forever preferred_lft forever\n" +
		"2: eth0    inet 203.0.113.11/32 scope global eth0\\       valid_lft forever preferred_lft forever\n"
	got := inetAddrs(out)
	if want := []string{"203.0.113.10", "203.0.113.11"}; !slices.Equal(got, want) {
		t.Errorf("inetAddrs = %v, want %v", got, want)
	}
	if got := inetAddrs(""); len(got) != 0 {
		t.Errorf("inetAddrs(\"\") = %v", got)
	}
}

func TestIsLocalRoute(t *testing.T) {
	if !isLocalRoute("local 203.0.113.10 dev lo src 203.0.113.10 uid 0 \n    cache <local> \n") {
		t.Error("local route not recognised")
	}
	if isLocalRoute("203.0.113.10 via 203.0.113.1 dev eth0 src 203.0.113.10 uid 0\n") {
		t.Error("forwarded route treated as local")
	}
	if isLocalRoute("") {
		t.Error("empty output treated as local")
	}
}
