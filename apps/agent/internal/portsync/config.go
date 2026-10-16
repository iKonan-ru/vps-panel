// Package portsync считает желаемое состояние firewall port-sync: какие порты открыть на хосте
// (ufw) и для контейнеров (цепочка VPS-PORTSYNC в DOCKER-USER). Применяет его vps-portsync.py,
// получая состояние командой агента -portsync-state.
package portsync

import (
	"encoding/json"
	"os"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/lockout"
)

// Config - /etc/vps-portsync.conf.
type Config struct {
	AdminIPs        []string `json:"admin_ips"`
	DenyPublicPorts []string `json:"deny_public_ports"`
	ExtraAllow      []string `json:"extra_allow"`
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

// ReadConfig читает конфиг с диска; ключи, которых в нём нет, - по умолчанию.
func ReadConfig() Config {
	cfg := DefaultConfig()
	if b, err := os.ReadFile(hostfs.Path(ConfPath)); err == nil {
		_ = json.Unmarshal(b, &cfg)
	}
	return cfg
}
