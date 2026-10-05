package adapters

import (
	"strings"
	"testing"
)

const confPeers = `[Interface]
PrivateKey = SERVERPRIV=
Address = 10.8.1.0/24
ListenPort = 41721
Jc = 5
# I1 = <r 2>

[Peer]
PublicKey = AAAA
PresharedKey = PSK=
AllowedIPs = 10.8.1.2/32

[Peer]
PublicKey = BBBB
PresharedKey = PSK=
AllowedIPs = 10.8.1.3/32
`

func TestRemovePeer(t *testing.T) {
	out, ok := removePeer(confPeers, "AAAA")
	if !ok {
		t.Fatal("не нашёл AAAA")
	}
	if strings.Contains(out, "AAAA") || !strings.Contains(out, "BBBB") || !strings.Contains(out, "# I1 = <r 2>") {
		t.Fatalf("лишнее удалено или нужное потеряно:\n%s", out)
	}
	if strings.Contains(out, "\n\n\n") {
		t.Fatalf("двойные пустые строки:\n%s", out)
	}
	// подстрока чужого ключа не должна совпасть (у AWP удаление по подстроке)
	if _, ok := removePeer(confPeers, "AAA"); ok {
		t.Fatal("удалил по подстроке ключа")
	}
	out2, _ := removePeer(out, "BBBB")
	if _, peers := parseAwgConf(out2); len(peers) != 0 {
		t.Fatalf("остались пиры: %v", peers)
	}
	if !strings.HasPrefix(out2, "[Interface]") || !strings.Contains(out2, "ListenPort = 41721") {
		t.Fatalf("интерфейс повреждён:\n%s", out2)
	}
}

func TestAppendPeerAndNextIP(t *testing.T) {
	table, _ := loadTable(`[{"clientId":"CCCC","userData":{"clientName":"off","enabled":false,"clientIp":"10.8.1.4"}}]`)
	ip, err := nextAwgIP(confPeers, table)
	if err != nil || ip != "10.8.1.5" {
		t.Fatalf("ждали 10.8.1.5 (2,3 - пиры, 4 - выключенный): %s %v", ip, err)
	}
	conf := appendPeer(confPeers, "DDDD", "PSK=", ip+"/32")
	if _, peers := parseAwgConf(conf); peers["DDDD"] != "10.8.1.5/32" || len(peers) != 3 {
		t.Fatalf("пир не добавился: %v", peers)
	}
	if !ipTaken(conf, "10.8.1.5") || ipTaken(conf, "10.8.1.6") {
		t.Fatal("ipTaken")
	}
	small := strings.Replace(confPeers, "10.8.1.0/24", "10.8.1.0/30", 1)
	if _, err := nextAwgIP(small, nil); err == nil {
		t.Fatal("в /30 с занятым .2 адресов нет - ждали ошибку")
	}
	wide := strings.Replace(confPeers, "10.8.1.0/24", "10.8.0.0/16", 1)
	if ip, _ := nextAwgIP(wide, nil); ip != "10.8.0.2" {
		t.Fatalf("/16: %s", ip)
	}
}

func TestTable(t *testing.T) {
	table, err := loadTable(`{"AAAA":{"clientName":"ivan"}}`)
	if err != nil || len(table) != 1 || tableIndex(table, "AAAA") != 0 {
		t.Fatalf("старый формат: %v %v", table, err)
	}
	ud := userData(&table, "BBBB")
	ud["clientName"] = "new"
	if len(table) != 2 || tableIndex(table, "BBBB") != 1 {
		t.Fatalf("запись не создана: %v", table)
	}
	keep, _ := loadTable(`[{"clientId":"AAAA","userData":{"clientName":"x","maxSpeed":10,"clientPrivateKey":"k"}}]`)
	userData(&keep, "AAAA")["clientName"] = "y"
	u := keep[0]["userData"].(map[string]any)
	if u["maxSpeed"] != float64(10) || u["clientPrivateKey"] != "k" {
		t.Fatalf("чужие поля потеряны: %v", u)
	}
	if tableIPs(map[string]any{"clientIp": "10.8.1.7"}) != "10.8.1.7/32" {
		t.Fatal("tableIPs clientIp")
	}
	if _, err := loadTable("{broken"); err == nil {
		t.Fatal("битая таблица должна дать ошибку")
	}
}

func TestValidation(t *testing.T) {
	if !reWgKey.MatchString("yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=") {
		t.Fatal("настоящий ключ отвергнут")
	}
	for _, bad := range []string{"", "AAAA", "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk", "yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBml="} {
		if reWgKey.MatchString(bad) {
			t.Fatalf("принят неверный ключ %q", bad)
		}
	}
	if !validClientName("Иван телефон") || validClientName("") || validClientName("a\nb") || validClientName(strings.Repeat("я", 65)) {
		t.Fatal("validClientName")
	}
	for _, ok := range []string{"", "android", "ios", "router"} {
		if !reAwgDevice.MatchString(ok) {
			t.Fatalf("устройство %q отвергнуто", ok)
		}
	}
	for _, bad := range []string{"Android", "phone", "ios\n", "linux "} {
		if reAwgDevice.MatchString(bad) {
			t.Fatalf("принято устройство %q", bad)
		}
	}
}

func TestPeerPSK(t *testing.T) {
	conf := strings.Replace(confPeers, "PresharedKey = PSK=\nAllowedIPs = 10.8.1.3/32", "PresharedKey = OWN=\nAllowedIPs = 10.8.1.3/32", 1)
	if peerPSK(conf, "AAAA") != "PSK=" || peerPSK(conf, "BBBB") != "OWN=" || peerPSK(conf, "CCCC") != "" {
		t.Fatalf("peerPSK: %q %q", peerPSK(conf, "AAAA"), peerPSK(conf, "BBBB"))
	}
}

func TestReplaceInterfaceParams(t *testing.T) {
	out := replaceInterfaceParams(confPeers, map[string]string{"Jc": "3", "S1": "40", "H1": "5-100", "I1": "<b 0x01>"})
	params, peers := parseAwgConf(out)
	if len(peers) != 2 {
		t.Fatalf("пиры потеряны:\n%s", out)
	}
	got := map[string]string{}
	for _, p := range params {
		got[p.Key] = p.Value
	}
	if got["Jc"] != "3" || got["S1"] != "40" || got["H1"] != "5-100" || got["I1"] != "<b 0x01>" {
		t.Fatalf("новые параметры: %v", got)
	}
	if got["Address"] != "10.8.1.0/24" || got["ListenPort"] != "41721" || !strings.Contains(out, "PrivateKey = SERVERPRIV=") {
		t.Fatalf("адрес, порт или ключ сервера потеряны:\n%s", out)
	}
	if strings.Count(out, "I1 =") != 1 || !strings.Contains(out, "# I1 = <b 0x01>") {
		t.Fatalf("старый I1 не убран или новый не комментарием:\n%s", out)
	}
	if strings.Index(out, "# I1") > strings.Index(out, "[Peer]") {
		t.Fatalf("параметры не в [Interface]:\n%s", out)
	}
}
