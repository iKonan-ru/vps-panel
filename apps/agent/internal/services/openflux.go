package services

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// OpenFlux ставится мастером "Своя нода" приложений OpenFlux (node-install.sh): каждый канал -
// /etc/openflux-node/<канал>/ (node.conf, ключ, port) и служба openflux-node@<канал>, ядро -
// /opt/openflux-node/bin/openflux -> openflux-node-vX.Y.Z, обновление - таймер
// openflux-node-update. Всё читается из файлов и systemd: скрипт установщика не запускаем,
// секреты (ключ, адреса транспортов в node.conf) не читаем.
const (
	openfluxEtc = "/etc/openflux-node"
	openfluxBin = "/opt/openflux-node/bin/openflux"
)

type openfluxChannel struct {
	Name    string `json:"channel"`
	Port    int    `json:"port"`
	State   string `json:"state"`
	Enabled bool   `json:"enabled"`
}

// down - канал включён, но не работает (выключенный - например, клиент панели выключен - не авария)
func (c openfluxChannel) down() bool { return c.Enabled && c.State != "active" }

// OpenfluxPort - канал OpenFlux и порт из его файла port (0 - файл не прочитался или не число).
type OpenfluxPort struct {
	Channel string
	Port    int
}

// OpenfluxPorts - установленные каналы OpenFlux по имени, без обращения к systemd.
func OpenfluxPorts() []OpenfluxPort {
	files, _ := filepath.Glob(filepath.Join(hostfs.Path(openfluxEtc), "*", "port"))
	var out []OpenfluxPort
	for _, p := range files {
		b, _ := os.ReadFile(p)
		port, _ := strconv.Atoi(strings.TrimSpace(string(b)))
		out = append(out, OpenfluxPort{Channel: filepath.Base(filepath.Dir(p)), Port: port})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Channel < out[j].Channel })
	return out
}

func openfluxChannels(ctx context.Context) []openfluxChannel {
	var out []openfluxChannel
	for _, c := range OpenfluxPorts() {
		unit := "openflux-node@" + c.Channel
		enabled := strings.TrimSpace(shell.Out(ctx, "systemctl", "is-enabled", unit)) == "enabled"
		out = append(out, openfluxChannel{Name: c.Channel, Port: c.Port, State: unitActive(ctx, unit), Enabled: enabled})
	}
	return out
}

// openfluxVersion: openflux-node-v1.2.0 -> 1.2.0.
func openfluxVersion() string {
	t, err := os.Readlink(openfluxBin)
	if err != nil {
		return ""
	}
	return strings.TrimPrefix(filepath.Base(t), "openflux-node-v")
}

func openflux(ctx context.Context) (proto.Service, bool) {
	chans := openfluxChannels(ctx)
	if len(chans) == 0 {
		return proto.Service{}, false
	}
	s := proto.Service{Kind: "openflux", Title: "OpenFlux", Version: openfluxVersion(), Ports: []string{}}
	list := []map[string]any{}
	var down []string
	for _, c := range chans {
		if c.Port > 0 {
			s.Ports = append(s.Ports, strconv.Itoa(c.Port)+"/tcp "+c.Name)
		}
		list = append(list, map[string]any{"channel": c.Name, "port": c.Port, "state": c.State, "enabled": c.Enabled})
		if c.down() {
			down = append(down, "канал "+c.Name+": "+c.State)
		}
	}
	auto := unitActive(ctx, "openflux-node-update.timer") == "active"
	if auto {
		s.Ports = append(s.Ports, "автообновление ядра")
	}
	s.Details = map[string]any{"channels": list, "autoupdate": auto}
	markDown(&s, len(down) > 0, strings.Join(down, ", "))
	return s, true
}

// openfluxDown - каналы, чья служба не active (для Health).
func openfluxDown(ctx context.Context) []string {
	var down []string
	for _, c := range openfluxChannels(ctx) {
		if c.down() {
			down = append(down, "openflux:"+c.Name)
		}
	}
	return down
}
