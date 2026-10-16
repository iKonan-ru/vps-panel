// Package portsync считает желаемое состояние firewall port-sync: какие порты открыть на хосте
// (ufw) и для контейнеров (цепочка VPS-PORTSYNC в DOCKER-USER). Применяет его vps-portsync.py,
// получая состояние командой агента -portsync-state.
package portsync

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/lockout"
)

// Config - /etc/vps-portsync.conf.
type Config struct {
	AdminIPs        []string `json:"admin_ips"`
	DenyPublicPorts PortList `json:"deny_public_ports"`
	ExtraAllow      PortList `json:"extra_allow"`
	KnownProcesses  []string `json:"known_processes"`
	DockerPolicy    string   `json:"docker_policy"`
	AllowPing       bool     `json:"allow_ping"`
	WanInterface    string   `json:"wan_interface"`
	SSHPort         int      `json:"ssh_port"`
}

// ConfPath - путь к конфигу.
const ConfPath = "/etc/vps-portsync.conf"

func DefaultConfig() Config {
	return Config{
		AdminIPs:        []string{},
		DenyPublicPorts: []string{"9090/tcp", "9091/tcp", "62789/tcp"},
		ExtraAllow:      []string{},
		KnownProcesses:  lockout.KnownProcesses(),
		DockerPolicy:    "published",
		AllowPing:       true,
	}
}

// PortList - порты вида "443" или "443/tcp"; число в JSON (51820) - тоже порт.
type PortList []string

func (l *PortList) UnmarshalJSON(b []byte) error {
	var raw []json.RawMessage
	if err := json.Unmarshal(b, &raw); err != nil {
		return err
	}
	if raw == nil {
		*l = nil
		return nil
	}
	out := PortList{}
	for _, r := range raw {
		var s string
		if json.Unmarshal(r, &s) == nil {
			out = append(out, s)
			continue
		}
		var n int
		if err := json.Unmarshal(r, &n); err != nil {
			return fmt.Errorf("порт %s: нужна строка или целое число", r)
		}
		out = append(out, strconv.Itoa(n))
	}
	*l = out
	return nil
}

// ReadConfig читает конфиг с диска; ключи, которых в нём нет, - по умолчанию. Нет файла -
// настройки по умолчанию, но без deny_public_ports: так port-sync работал без конфига всегда, и
// закрыть порт работающего сервиса нельзя. Файл не читается или не разбирается - ошибка: по
// настройкам по умолчанию port-sync снял бы extra_allow и правила admin_ips.
func ReadConfig() (Config, error) {
	cfg := DefaultConfig()
	b, err := os.ReadFile(hostfs.Path(ConfPath))
	if errors.Is(err, fs.ErrNotExist) {
		cfg.DenyPublicPorts = PortList{}
		return cfg, nil
	}
	if err != nil {
		return cfg, fmt.Errorf("конфиг port-sync %s: %w", ConfPath, err)
	}
	if err := json.Unmarshal(b, &cfg); err != nil {
		return cfg, fmt.Errorf("конфиг port-sync %s не разбирается: %w", ConfPath, err)
	}
	return cfg, nil
}
