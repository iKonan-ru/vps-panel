package adapters

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseXuiClients(t *testing.T) {
	raw := json.RawMessage(`[
		{"email":"ivan-a1b2","uuid":"secret-uuid","subId":"sub","traffic":{"up":10,"down":20,"lastOnline":1759830000000,"uuid":"x"}},
		{"email":"petr-c3d4"},
		{"email":"","traffic":{"up":1}}
	]`)
	m, err := parseXuiClients(raw)
	if err != nil {
		t.Fatal(err)
	}
	if len(m) != 2 {
		t.Fatalf("клиентов %d, ждали 2", len(m))
	}
	if s := m["ivan-a1b2"]; s.Up != 10 || s.Down != 20 || s.LastOnline != 1759830000000 {
		t.Errorf("ivan: %+v", s)
	}
	if s := m["petr-c3d4"]; s != (XuiClientStat{}) {
		t.Errorf("petr: %+v", s)
	}
	b, _ := json.Marshal(m)
	if strings.Contains(string(b), "secret") || strings.Contains(string(b), "sub") {
		t.Errorf("в ответ попали uuid или subId: %s", b)
	}
	if m, err := parseXuiClients(json.RawMessage(`null`)); err != nil || len(m) != 0 {
		t.Errorf("null: %v %v", m, err)
	}
}

func TestParseAwgDumpAll(t *testing.T) {
	text := "awg0\tPRIV\tPUB\t51820\toff\t5\t10\t50\t1\t2\t3\t4\t0\t0\t0\n" +
		"awg0\tpeerA=\tpsk\t1.2.3.4:5000\t10.8.1.2/32\t1759830000\t100\t200\toff\n" +
		"awg0\tpeerB=\t(none)\t(none)\t10.8.1.3/32\t0\t0\t0\toff\n"
	m := parseAwgDumpAll(text)
	if len(m) != 2 {
		t.Fatalf("пиров %d, ждали 2: %+v", len(m), m)
	}
	if s := m["peerA="]; s.Handshake != 1759830000 || s.Rx != 100 || s.Tx != 200 {
		t.Errorf("peerA: %+v", s)
	}
	if s := m["peerB="]; s.Handshake != 0 {
		t.Errorf("peerB: %+v", s)
	}
}

func TestParseTelemtConfig(t *testing.T) {
	cfg := `[general]
port = 1
[server]
port = 443
metrics_listen = "127.0.0.1:9090"
[server.api]
listen = "127.0.0.1:9091"
auth_header = "Bearer x"
[access.users]
ivan = "00112233445566778899aabbccddeeff"
`
	a := parseTelemtConfig(cfg)
	if a.metrics != "127.0.0.1:9090" || a.api != "127.0.0.1:9091" || a.auth != "Bearer x" {
		t.Errorf("%+v", a)
	}
	a = parseTelemtConfig("[server]\nmetrics_port = 9095 # порт\n[server.api]\nenabled = false\nlisten = \"127.0.0.1:9091\"\n")
	if a.metrics != "127.0.0.1:9095" || a.api != "" {
		t.Errorf("metrics_port и выключенный api: %+v", a)
	}
}

func TestParseTelemtMetrics(t *testing.T) {
	text := `# HELP telemt_user_connections_current Per-user active connections
# TYPE telemt_user_connections_current gauge
telemt_user_connections_current{user="ivan-a1b2"} 4
telemt_user_octets_from_client_total{user="ivan-a1b2"} 30248
telemt_user_octets_to_client_total{user="ivan-a1b2"} 9.3224e+04
telemt_user_octets_from_client{user="old-c3d4"} 5
telemt_user_octets_to_client{user="old-c3d4"} 6
telemt_user_msgs_total{user="ivan-a1b2"} 99
telemt_connections_total 7
`
	m := parseTelemtMetrics(strings.NewReader(text))
	if s := m["ivan-a1b2"]; s.Conns != 4 || s.In != 30248 || s.Out != 93224 {
		t.Errorf("ivan: %+v", s)
	}
	if s := m["old-c3d4"]; s.In != 5 || s.Out != 6 {
		t.Errorf("старые имена: %+v", s)
	}
	if len(m) != 2 {
		t.Errorf("пользователей %d: %+v", len(m), m)
	}
}

func TestParseTelemtActiveIPs(t *testing.T) {
	m, err := parseTelemtActiveIPs([]byte(`{"ok":true,"data":[{"username":"ivan-a1b2","active_ips":["1.2.3.4","5.6.7.8"]}],"revision":"r"}`))
	if err != nil || m["ivan-a1b2"] != 2 {
		t.Errorf("%v %v", m, err)
	}
}

func TestParseWdttPasswords(t *testing.T) {
	m, err := parseWdttPasswords([]byte(`{"passwords":[{"password":"p1","down_bytes":7,"up_bytes":3,"active_devices":1},{"password":"","down_bytes":1}]}`))
	if err != nil {
		t.Fatal(err)
	}
	k := WdttStatKey("p1")
	if len(k) != 16 || len(m) != 1 {
		t.Fatalf("%v %q", m, k)
	}
	if s := m[k]; s.Up != 3 || s.Down != 7 || s.Devices != 1 {
		t.Errorf("%+v", s)
	}
	b, _ := json.Marshal(m)
	if strings.Contains(string(b), "p1") {
		t.Errorf("пароль в ответе: %s", b)
	}
}

func TestParseOfShowAndSs(t *testing.T) {
	show := "Id=openflux-node@vp-aaa.service\nActiveState=active\nActiveEnterTimestamp=Tue 2026-10-07 12:00:00 UTC\n\n" +
		"Id=openflux-node@vp-bbb.service\nActiveState=inactive\nActiveEnterTimestamp=Tue 2026-10-07 11:00:00 UTC\n"
	m := parseOfShow(show)
	if s := m["vp-aaa"]; !s.Active || s.Since != "2026-10-07T12:00:00Z" {
		t.Errorf("vp-aaa: %+v", s)
	}
	if s := m["vp-bbb"]; s.Active || s.Since != "" {
		t.Errorf("vp-bbb: %+v", s)
	}
	ss := "0      0      10.0.0.1:32960     5.6.7.8:51000\n0 0 [::ffff:10.0.0.1]:32960 [::ffff:1.1.1.1]:4000\n0 0 10.0.0.1:22 9.9.9.9:1\n"
	c := countEstablished(ss)
	if c[32960] != 2 || c[22] != 1 {
		t.Errorf("%v", c)
	}
}
