package services

import (
	"context"
	"encoding/json"
	"fmt"
	"os"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

// Прокси для браузера: служба vps-naive, настройки -
// /etc/vps-naive/config.json. Установлен - есть файл службы (упавший сервис не пропадает из
// списка, иначе сверка через 30 минут стёрла бы привязки клиентов).
var (
	naiveUnitFile   = "/etc/systemd/system/vps-naive.service"
	naiveConfigFile = "/etc/vps-naive/config.json"
)

func naive(ctx context.Context) (proto.Service, bool) {
	if _, err := os.Stat(naiveUnitFile); err != nil {
		return proto.Service{}, false
	}
	var c struct {
		Domain    string `json:"domain"`
		Port      int    `json:"port"`
		Listen443 bool   `json:"listen443"`
		Mask443   bool   `json:"mask443"`
		HTTP80    bool   `json:"http80"`
	}
	if b, err := os.ReadFile(naiveConfigFile); err == nil {
		_ = json.Unmarshal(b, &c)
	}
	s := proto.Service{Kind: "naive", Title: "Браузер (naive)", Ports: []string{}, Details: map[string]any{"domain": c.Domain}}
	if c.Port > 0 {
		s.Ports = append(s.Ports, fmt.Sprintf("%d/tcp прокси", c.Port))
	}
	if c.Listen443 {
		s.Ports = append(s.Ports, "443/tcp прокси")
	}
	if c.Mask443 {
		s.Ports = append(s.Ports, "443/tcp через MTProxyL")
	}
	if c.HTTP80 {
		s.Ports = append(s.Ports, "80/tcp сертификат")
	}
	st := unitActive(ctx, "vps-naive")
	markDown(&s, st != "active", "служба vps-naive: "+st)
	return s, true
}
