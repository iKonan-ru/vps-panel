package adapters

import (
	"encoding/json"
	"errors"
	"net/netip"
	"strings"
	"time"
)

// loadTable читает clientsTable с сохранением всех полей записей; старый формат-объект
// переводится в массив, как это делает приложение.
func loadTable(text string) ([]map[string]any, error) {
	text = strings.TrimSpace(text)
	if text == "" {
		return []map[string]any{}, nil
	}
	var list []map[string]any
	if err := json.Unmarshal([]byte(text), &list); err == nil {
		return list, nil
	}
	var obj map[string]map[string]any
	if err := json.Unmarshal([]byte(text), &obj); err != nil {
		return nil, err
	}
	list = make([]map[string]any, 0, len(obj))
	for k, v := range obj {
		list = append(list, map[string]any{"clientId": k, "userData": v})
	}
	return list, nil
}

func hasPeer(peers map[string]string, key string) bool {
	_, ok := peers[key]
	return ok
}

func tableIndex(table []map[string]any, key string) int {
	for i, e := range table {
		if id, _ := e["clientId"].(string); id == key {
			return i
		}
	}
	return -1
}

// userData возвращает userData записи клиента, создавая запись при необходимости.
func userData(table *[]map[string]any, key string) map[string]any {
	i := tableIndex(*table, key)
	if i < 0 {
		*table = append(*table, map[string]any{"clientId": key, "userData": map[string]any{
			"clientName": "", "creationDate": time.Now().Format(awgTimeFt)}})
		i = len(*table) - 1
	}
	ud, ok := (*table)[i]["userData"].(map[string]any)
	if !ok {
		ud = map[string]any{}
		(*table)[i]["userData"] = ud
	}
	return ud
}

// tableIPs - адреса клиента из записи: allowed_ips (приложение), allowedIps или clientIp (AWP).
func tableIPs(ud map[string]any) string {
	for _, k := range []string{"allowed_ips", "allowedIps"} {
		if v, _ := ud[k].(string); v != "" {
			return v
		}
	}
	if v, _ := ud["clientIp"].(string); v != "" {
		return v + "/32"
	}
	return ""
}

// appendPeer дописывает [Peer] в конец конфига (как приложение), с пустой строкой перед ним.
func appendPeer(conf, key, psk, ips string) string {
	b := strings.TrimRight(conf, "\n") + "\n\n[Peer]\nPublicKey = " + key + "\n"
	if psk != "" {
		b += "PresharedKey = " + psk + "\n"
	}
	return b + "AllowedIPs = " + ips + "\n"
}

// removePeer убирает секцию [Peer] с точно этим PublicKey; остальной текст не трогает.
func removePeer(conf, key string) (string, bool) {
	lines := strings.Split(conf, "\n")
	type sect struct{ start, end int }
	var sects []sect
	for i, l := range lines {
		if strings.HasPrefix(strings.TrimSpace(l), "[") {
			if len(sects) > 0 {
				sects[len(sects)-1].end = i
			}
			sects = append(sects, sect{i, len(lines)})
		}
	}
	for _, s := range sects {
		if !strings.EqualFold(strings.Trim(strings.TrimSpace(lines[s.start]), "[] "), "peer") {
			continue
		}
		for _, l := range lines[s.start:s.end] {
			k, v, ok := strings.Cut(strings.TrimSpace(l), "=")
			if ok && strings.EqualFold(strings.TrimSpace(k), "PublicKey") && strings.TrimSpace(v) == key {
				out := append(append([]string{}, lines[:s.start]...), lines[s.end:]...)
				text := strings.Join(out, "\n")
				// после вырезания не оставляем подряд пустые строки
				for strings.Contains(text, "\n\n\n") {
					text = strings.ReplaceAll(text, "\n\n\n", "\n\n")
				}
				return strings.TrimRight(text, "\n") + "\n", true
			}
		}
	}
	return conf, false
}

// ipTaken - занят ли IPv4 одним из пиров конфига.
func ipTaken(conf, ip string) bool {
	_, peers := parseAwgConf(conf)
	for _, ips := range peers {
		for _, p := range strings.Split(ips, ",") {
			if strings.TrimSuffix(strings.TrimSpace(p), "/32") == ip {
				return true
			}
		}
	}
	return false
}

// nextAwgIP - первый свободный IPv4 в подсети сервера (Address), начиная со второго адреса:
// занятыми считаются пиры конфига и все записи clientsTable, включая выключенных.
func nextAwgIP(conf string, table []map[string]any) (string, error) {
	params, peers := parseAwgConf(conf)
	var prefix netip.Prefix
	var server netip.Addr
	for _, p := range params {
		if p.Key != "Address" {
			continue
		}
		for _, part := range strings.Split(p.Value, ",") {
			if pf, err := netip.ParsePrefix(strings.TrimSpace(part)); err == nil && pf.Addr().Is4() {
				prefix, server = pf.Masked(), pf.Addr()
				break
			}
		}
	}
	if !prefix.IsValid() {
		return "", errors.New("в конфиге сервера нет Address с IPv4")
	}
	used := map[netip.Addr]bool{server: true}
	mark := func(ips string) {
		for _, part := range strings.Split(ips, ",") {
			part = strings.TrimSpace(part)
			if a, err := netip.ParseAddr(strings.TrimSuffix(part, "/32")); err == nil {
				used[a] = true
			}
		}
	}
	for _, ips := range peers {
		mark(ips)
	}
	for _, e := range table {
		if ud, ok := e["userData"].(map[string]any); ok {
			mark(tableIPs(ud))
		}
	}
	a := prefix.Addr().Next() // .1 пропускаем: у части установок это адрес сервера
	for a = a.Next(); prefix.Contains(a); a = a.Next() {
		if !prefix.Contains(a.Next()) {
			break // широковещательный
		}
		if !used[a] {
			return a.String(), nil
		}
	}
	return "", errors.New("в подсети " + prefix.String() + " не осталось свободных адресов")
}

// peerPSK - PresharedKey пира с этим ключом в конфиге сервера.
func peerPSK(conf, key string) string {
	section, cur, psk := "", "", ""
	for _, raw := range strings.Split(conf, "\n") {
		line := strings.TrimSpace(raw)
		if strings.HasPrefix(line, "[") {
			if section == "peer" && cur == key {
				return psk
			}
			section, cur, psk = strings.ToLower(strings.Trim(line, "[] ")), "", ""
			continue
		}
		k, v, ok := strings.Cut(line, "=")
		if !ok || section != "peer" {
			continue
		}
		switch strings.ToLower(strings.TrimSpace(k)) {
		case "publickey":
			cur = strings.TrimSpace(v)
		case "presharedkey":
			psk = strings.TrimSpace(v)
		}
	}
	if section == "peer" && cur == key {
		return psk
	}
	return ""
}
