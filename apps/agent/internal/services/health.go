package services

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Работает ли сервис, а не только установлен ли он: xray 3X-UI может лежать, пока сам сервис
// числится установленным. Упавший сервис остаётся в списке с Details["down"] и
// причиной в Details["downReason"]: аудит делает из этого критичное замечание, а сверка
// клиентов не принимает упавший сервис за удалённый.

const wdttUnitFile = "/etc/systemd/system/wdtt.service"

// флаг целым словом (-listen не совпадает с -listen-direct), значение через пробел или "=",
// "-" или "--" - как у пакета flag в Go, которым wdtt-server их разбирает
var reWdttFlag = regexp.MustCompile(`(?:^|[\s"'])--?(listen|admin-listen|wg-port)(?:=|\s+)([^\s"']+)`)

// WdttFlagPorts - порты флагов wdtt-server в тексте юнита: -listen и -admin-listen
// (адрес:порт), -wg-port (порт); имя флага -> порты по порядку.
func WdttFlagPorts(unit string) map[string][]int {
	out := map[string][]int{}
	for _, m := range reWdttFlag.FindAllStringSubmatch(unit, -1) {
		v := m[2]
		if i := strings.LastIndex(v, ":"); i >= 0 {
			v = v[i+1:]
		}
		n, _ := strconv.Atoi(v)
		out[m[1]] = append(out[m[1]], n)
	}
	return out
}

// wdttInstalled - есть служба wdtt (наличие по установке: упавший процесс - не удалённый сервис).
func wdttInstalled() bool {
	_, err := os.Stat(wdttUnitFile)
	return err == nil
}

// wdttUnitPort - порт DTLS из ExecStart службы (когда процесс не слушает).
func wdttUnitPort() int {
	b, err := os.ReadFile(wdttUnitFile)
	if err != nil {
		return 0
	}
	return parseWdttListen(string(b))
}

func parseWdttListen(unit string) int {
	if p := WdttFlagPorts(unit)["listen"]; len(p) > 0 {
		return p[0]
	}
	return 0
}

// unitActive - systemctl is-active (active, activating, failed, inactive...).
func unitActive(ctx context.Context, unit string) string {
	return strings.TrimSpace(shell.Out(ctx, "systemctl", "is-active", unit))
}

// mtproxyDown - порт прокси MTProxyL никто не слушает (telemt в docker или бинарником).
func mtproxyDown(ctx context.Context, port int) bool {
	return port > 0 && !firewall.TCPListening(ctx, port)
}

// wgDownIfaces - интерфейсы WireGuard/AWG, которые должны подниматься при загрузке
// (wg-quick@<имя> или awg-quick@<имя> включён), а сейчас не подняты.
func wgDownIfaces(ctx context.Context) []string {
	var down []string
	for _, d := range []struct{ dir, unit string }{
		{"/etc/wireguard", "wg-quick@"},
		{"/etc/amnezia/amneziawg", "awg-quick@"},
	} {
		confs, _ := filepath.Glob(filepath.Join(d.dir, "*.conf"))
		for _, c := range confs {
			name := strings.TrimSuffix(filepath.Base(c), ".conf")
			if strings.HasPrefix(name, "wdtt") {
				continue
			}
			if _, err := os.Stat(filepath.Join("/sys/class/net", name)); err == nil {
				continue
			}
			if strings.TrimSpace(shell.Out(ctx, "systemctl", "is-enabled", d.unit+name)) == "enabled" {
				down = append(down, name)
			}
		}
	}
	sort.Strings(down)
	return down
}

// containerDown - контейнер сервиса не в состоянии running (exited, restarting, paused...).
func containerDown(c proto.Container) bool { return c.State != "running" }

// reported - Health последнего ушедшего снимка: проверка раз в 30 с сравнивает с ним, а не со
// своей прошлой проверкой. Иначе снимок, снятый посреди перезапуска (панель запрашивает его
// сразу после действия, а telemt ещё не занял порт), показывал бы "упало" до следующего
// планового снимка через 5 минут.
var reported atomic.Value

// MarkReported - запомнить состояние, с которым снимок ушёл панели.
func MarkReported(h string) { reported.Store(h) }

// Reported - состояние последнего снимка ("" - ничего не упало или снимка ещё не было).
func Reported() string {
	v, _ := reported.Load().(string)
	return v
}

// Health - короткий список упавших сервисов ("xui", "mtproxyl", "amnezia-awg2", "wdtt",
// "wg0", "wg-easy"): агент проверяет его раз в 30 с и при изменении сразу шлёт снимок.
func Health(ctx context.Context, containers []proto.Container) string {
	var down []string
	if XuiInstalled() && XrayState(ctx).Down() {
		down = append(down, "xui")
	}
	if mtproxyDown(ctx, MtproxyPort()) {
		down = append(down, "mtproxyl")
	}
	for _, c := range containers {
		if isServiceContainer(c.Name) && containerDown(c) {
			down = append(down, c.Name)
		}
	}
	if wdttInstalled() && unitActive(ctx, "wdtt") != "active" {
		down = append(down, "wdtt")
	}
	down = append(down, wgDownIfaces(ctx)...)
	down = append(down, openfluxDown(ctx)...)
	return strings.Join(down, ",")
}

// isServiceContainer - контейнер, который панель показывает сервисом (Amnezia, wg-easy).
func isServiceContainer(name string) bool {
	return (strings.HasPrefix(name, "amnezia-") && !strings.Contains(name, "panel")) ||
		strings.Contains(name, "wg-easy")
}
