package adapters

import "testing"

const conf31 = `[Interface]
PrivateKey = SERVERPRIV=
Address = 10.8.1.0/24
ListenPort = 41721
Jc = 5
Jmin = 10
Jmax = 50
S1 = 12
S2 = 12
S3 = 12
S4 = 12
H1 = 1
H2 = 2
H3 = 3
H4 = 4
HeaderProtectionKey = HPK=
RekeyAfterTime = 100-120
RandomTrailers = on
DisableCookies = on
# I1 = <r 2><b 0x8580>
# MTU = 1376

[Peer]
PublicKey = AAA=
PresharedKey = PSK=
AllowedIPs = 10.8.1.2/32

[Peer]
PublicKey = BBB=
PresharedKey = PSK=
AllowedIPs = 10.8.1.3/32
`

func TestParseAwgConf(t *testing.T) {
	params, peers := parseAwgConf(conf31)
	if len(peers) != 2 || peers["AAA="] != "10.8.1.2/32" || peers["BBB="] != "10.8.1.3/32" {
		t.Fatalf("пиры: %v", peers)
	}
	var i1, mtu bool
	for _, p := range params {
		if p.Key == "I1" && p.Commented && p.Value == "<r 2><b 0x8580>" {
			i1 = true
		}
		if p.Key == "MTU" {
			mtu = true
		}
		if p.Key == "PublicKey" || p.Key == "PresharedKey" {
			t.Fatalf("параметр пира попал в интерфейс: %v", p)
		}
	}
	if !i1 || mtu {
		t.Fatalf("I1 из комментария должен быть, прочие комментарии - нет: %v", params)
	}
}

func TestAwgVersion(t *testing.T) {
	p := func(kv ...string) []AwgParam {
		out := []AwgParam{}
		for i := 0; i+1 < len(kv); i += 2 {
			out = append(out, AwgParam{Key: kv[i], Value: kv[i+1]})
		}
		return out
	}
	cases := []struct {
		name   string
		params []AwgParam
		want   string
	}{
		{"wg", p("ListenPort", "51820"), "wg"},
		{"1.0", p("Jc", "4", "S1", "20", "H1", "123"), "1.0"},
		{"1.5", p("Jc", "4", "H1", "123", "I1", "<b 0x01>"), "1.5"},
		{"2.0 по S3", p("Jc", "4", "S3", "20", "H1", "5"), "2.0"},
		{"2.0 по диапазону H", p("Jc", "4", "H1", "5-100"), "2.0"},
		{"3.0", p("S3", "12", "HeaderProtectionKey", "x"), "3.0"},
		{"3.1", p("S3", "12", "HeaderProtectionKey", "x", "RandomTrailers", "on"), "3.1"},
	}
	for _, c := range cases {
		if got := awgVersion(c.params); got != c.want {
			t.Errorf("%s: %s, ждали %s", c.name, got, c.want)
		}
	}
	params, _ := parseAwgConf(conf31)
	if v := awgVersion(params); v != "3.1" {
		t.Errorf("conf31: %s", v)
	}
}

func TestParseAwgDump(t *testing.T) {
	// строка интерфейса 3.1 - 30 полей, строки пиров - 8
	iface := "PRIV\tPUB\t41721\t5\t10\t50\t12\t12\t12\t12\t1\t2\t3\t4\t<r 2>\t(null)\t(null)\t(null)\t(null)\tHPK\t(null)\t100-120\t3-7\t150-180\t5-15\t15-20\ton\ton\toff\tx"
	dump := iface + "\nAAA=\tPSK=\t1.2.3.4:5555\t10.8.1.2/32\t1790000000\t100\t200\toff\nBBB=\tPSK=\t(none)\t10.8.1.3/32\t0\t0\t0\toff\n"
	s := parseAwgDump(dump)
	if len(s) != 2 {
		t.Fatalf("ждали 2 пира: %v", s)
	}
	if a := s["AAA="]; a.endpoint != "1.2.3.4:5555" || a.handshake != 1790000000 || a.rx != 100 || a.tx != 200 {
		t.Fatalf("AAA: %+v", a)
	}
	if b := s["BBB="]; b.endpoint != "" || b.handshake != 0 {
		t.Fatalf("BBB: %+v", b)
	}
}

func TestParseClientsTable(t *testing.T) {
	arr := `[{"clientId":"AAA=","userData":{"clientName":"ivan","device":"ios","creationDate":"Wed Sep 30 12:00:00 2026"}},
	{"clientId":"CCC=","userData":{"clientName":"off","enabled":false,"clientIp":"10.8.1.9","clientPrivateKey":"secret"}}]`
	list, err := parseClientsTable(arr)
	if err != nil || len(list) != 2 {
		t.Fatalf("массив: %v %v", list, err)
	}
	if list[0].device != "ios" || list[1].device != "" {
		t.Fatalf("устройство: %+v", list)
	}
	if c := list[1]; !c.disabled || c.ips != "10.8.1.9/32" {
		t.Fatalf("CCC: %+v", c)
	}
	old, err := parseClientsTable(`{"AAA=":{"clientName":"ivan"}}`)
	if err != nil || len(old) != 1 || old[0].name != "ivan" {
		t.Fatalf("старый формат: %v %v", old, err)
	}
	if empty, err := parseClientsTable("  \n"); err != nil || len(empty) != 0 {
		t.Fatalf("пустой: %v %v", empty, err)
	}
	if _, err := parseClientsTable("not json"); err == nil {
		t.Fatal("мусор должен дать ошибку")
	}
}

func TestMergeAwgClients(t *testing.T) {
	_, peers := parseAwgConf(conf31)
	stats := parseAwgDump("AAA=\tPSK=\t1.2.3.4:5\t10.8.1.2/32\t1790000000\t1\t2\toff\n")
	table, _ := parseClientsTable(`[{"clientId":"AAA=","userData":{"clientName":"ivan"}},{"clientId":"CCC=","userData":{"clientName":"off","enabled":false,"clientIp":"10.8.1.9"}}]`)
	got := mergeAwgClients(peers, stats, table)
	if len(got) != 3 {
		t.Fatalf("ждали 3 клиента: %+v", got)
	}
	if a := got[0]; a.Name != "ivan" || !a.InConfig || !a.InTable || a.Rx != 1 || a.AllowedIPs != "10.8.1.2/32" {
		t.Fatalf("ivan: %+v", a)
	}
	if c := got[1]; c.InConfig || !c.Disabled || c.AllowedIPs != "10.8.1.9/32" {
		t.Fatalf("выключенный: %+v", c)
	}
	if b := got[2]; b.PublicKey != "BBB=" || b.InTable || !b.InConfig {
		t.Fatalf("внешний: %+v", b)
	}
}
