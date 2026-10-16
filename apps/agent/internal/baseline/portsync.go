package baseline

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/fsutil"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/hostfs"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/lockout"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/portsync"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/sshd"
)

// PortsyncConfig - /etc/vps-portsync.conf.
type PortsyncConfig = portsync.Config

func DefaultPortsyncConfig() PortsyncConfig { return portsync.DefaultConfig() }

const (
	portsyncConf = portsync.ConfPath
	portsyncBin  = "/usr/local/sbin/vps-portsync"
)

// ReadPortsyncConfig читает конфиг с диска (portsync.ReadConfig).
func ReadPortsyncConfig() (PortsyncConfig, error) { return portsync.ReadConfig() }

// planConfig - конфиг, с которым port-sync будет работать после эталона: нет файла - тот, что
// запишет InstallPortsync.
func planConfig() (PortsyncConfig, error) {
	if _, err := os.Stat(hostfs.Path(portsyncConf)); err != nil {
		return DefaultPortsyncConfig(), nil
	}
	return ReadPortsyncConfig()
}

var (
	rePortSpec = regexp.MustCompile(`^[0-9]{1,5}(/(tcp|udp))?$`)
	reProcName = regexp.MustCompile(`^[A-Za-z0-9._*-]{1,32}$`)
	reIface    = regexp.MustCompile(`^[A-Za-z0-9._-]{1,15}$`)
)

// CheckPortsyncConfig - конфиг port-sync до записи: мусор ронял скрипт, а
// wan_interface "lo" пускал бы трафик мимо фильтра.
func CheckPortsyncConfig(cfg PortsyncConfig) error {
	for _, ip := range cfg.AdminIPs {
		if net.ParseIP(ip) == nil {
			if _, _, err := net.ParseCIDR(ip); err != nil {
				return fmt.Errorf("admin_ips: %q не IP и не подсеть", ip)
			}
		}
	}
	for _, list := range [][]string{cfg.DenyPublicPorts, cfg.ExtraAllow} {
		for _, p := range list {
			if !rePortSpec.MatchString(p) {
				return fmt.Errorf("порт %q: нужен вид 443 или 443/tcp", p)
			}
			n, _ := strconv.Atoi(strings.SplitN(p, "/", 2)[0])
			if n < 1 || n > 65535 {
				return fmt.Errorf("порт %q вне 1-65535", p)
			}
		}
	}
	for _, name := range cfg.KnownProcesses {
		if !reProcName.MatchString(name) {
			return fmt.Errorf("known_processes: %q", name)
		}
	}
	switch cfg.DockerPolicy {
	case "", "published", "explicit":
	default:
		return fmt.Errorf("docker_policy: %q", cfg.DockerPolicy)
	}
	if cfg.WanInterface != "" && (!reIface.MatchString(cfg.WanInterface) || cfg.WanInterface == "lo") {
		return fmt.Errorf("wan_interface: %q", cfg.WanInterface)
	}
	if cfg.SSHPort < 0 || cfg.SSHPort > 65535 {
		return fmt.Errorf("ssh_port: %d", cfg.SSHPort)
	}
	return nil
}

// ApplyPortsyncConfig записывает новые настройки port-sync. При включённом ufw сначала
// проверяется, что с ними не закроется открытый сейчас порт VPN: закроется - ошибка, и ничего
// не меняется.
func ApplyPortsyncConfig(ctx context.Context, cfg PortsyncConfig) error {
	if err := CheckPortsyncConfig(cfg); err != nil {
		return err
	}
	if fw := firewall.State(ctx); fw.UfwActive {
		allowed, err := plannedAllow(ctx, cfg)
		if err != nil {
			return fmt.Errorf("настройки port-sync не применены: не удалось рассчитать порты (%v)", err)
		}
		var open []proto.Listener
		for _, l := range fw.Listeners {
			if l.Open {
				open = append(open, l)
			}
		}
		if closing := lockout.ClosingVPN(open, allowed, deniedPorts(cfg), keepRules(fw.Rules)); len(closing) > 0 {
			return errors.New("настройки port-sync не применены: " + strings.Join(closing, "; "))
		}
	}
	return WritePortsyncConfig(cfg)
}

// keepRules - порты, открытые правилами ufw не от port-sync: новые настройки их не закроют.
func keepRules(rules []proto.FirewallRule) map[string]bool {
	return firewall.AllowedByRules(rules, func(r proto.FirewallRule) bool { return r.Origin != "portsync" })
}

func WritePortsyncConfig(cfg PortsyncConfig) error {
	if err := CheckPortsyncConfig(cfg); err != nil {
		return err
	}
	b, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return err
	}
	return fsutil.WriteAtomic(hostfs.Path(portsyncConf), b, 0o644)
}

// portsyncUnits - юниты port-sync: имя в systemd -> файл в assets.
var portsyncUnits = map[string]string{
	"vps-portsync.service":              "portsync.service",
	"vps-portsync.timer":                "portsync.timer",
	"vps-portsync-xui.path":             "portsync-xui.path",
	"vps-portsync-xui.service":          "portsync-xui.service",
	"vps-portsync-docker-watch.service": "portsync-docker-watch.service",
}

// portsyncCompanion - юнит, без которого не работает vps-portsync-xui.path: ставится и туда, где
// port-sync уже установлен без него (остальные юниты только обновляются - удалённый руками юнит
// не возвращается).
const portsyncCompanion = "vps-portsync-xui.service"

// RefreshPortsync обновляет установленный port-sync до встроенного в агента: скрипт и юниты, и
// поднимает vps-portsync-xui.path, если systemd выключил его по лимиту запусков или если он
// поменялся. port-sync не установлен - ничего не делает. true - что-то заменено.
func RefreshPortsync(ctx context.Context) (bool, error) {
	cur, err := os.ReadFile(hostfs.Path(portsyncBin))
	if err != nil {
		return false, nil
	}
	changed := false
	script, _ := assets.ReadFile("assets/vps-portsync.py")
	if !bytes.Equal(cur, script) {
		if err := fsutil.WriteAtomic(hostfs.Path(portsyncBin), script, 0o755); err != nil {
			return false, err
		}
		changed = true
	}
	units, pathUnit := false, false
	for unit, a := range portsyncUnits {
		path := hostfs.Path("/etc/systemd/system/" + unit)
		old, err := os.ReadFile(path)
		if err != nil && unit != portsyncCompanion {
			continue
		}
		b, _ := assets.ReadFile("assets/" + a)
		if err == nil && bytes.Equal(old, b) {
			continue
		}
		if err := fsutil.WriteAtomic(path, b, 0o644); err != nil {
			return changed, err
		}
		units = true
		pathUnit = pathUnit || unit == "vps-portsync-xui.path" || unit == portsyncCompanion
	}
	if units {
		changed = true
		systemctl(ctx, "systemctl daemon-reload")
	}
	restart := "! systemctl is-active --quiet vps-portsync-xui.path"
	if pathUnit {
		// новый Unit= путь подхватывает при перезапуске
		restart = "true"
	}
	systemctl(ctx, "if systemctl is-enabled --quiet vps-portsync-xui.path 2>/dev/null && "+restart+
		"; then systemctl reset-failed vps-portsync.service vps-portsync-xui.service vps-portsync-xui.path; "+
		"systemctl restart vps-portsync-xui.path; fi")
	return changed, nil
}

// systemctl - вызов systemctl для RefreshPortsync (тесты подменяют).
var systemctl = func(ctx context.Context, script string) {
	_, _ = shell.Run(ctx, script, time.Minute, nil)
}

// InstallPortsync кладёт скрипт, конфиг (если нет) и юниты.
func InstallPortsync(ctx context.Context, stream func(channel, chunk string)) error {
	script, _ := assets.ReadFile("assets/vps-portsync.py")
	if err := fsutil.WriteAtomic(hostfs.Path(portsyncBin), script, 0o755); err != nil {
		return err
	}
	if _, err := os.Stat(hostfs.Path(portsyncConf)); err != nil {
		cfg := DefaultPortsyncConfig()
		cfg.SSHPort = sshd.Port(sshd.Config(ctx))
		if err := WritePortsyncConfig(cfg); err != nil {
			return err
		}
	}
	for unit, a := range portsyncUnits {
		b, _ := assets.ReadFile("assets/" + a)
		if err := fsutil.WriteAtomic(hostfs.Path("/etc/systemd/system/"+unit), b, 0o644); err != nil {
			return err
		}
	}
	res, err := shell.Run(ctx, "systemctl daemon-reload", time.Minute, stream)
	if err != nil || res.ExitCode != 0 {
		return errors.New("systemctl daemon-reload не удался")
	}
	return nil
}

// RunPortsync запускает пересчёт и возвращает вывод.
func RunPortsync(ctx context.Context) (string, error) {
	if _, err := os.Stat(portsyncBin); err != nil {
		return "", errors.New("port-sync не установлен")
	}
	res, err := shell.Run(ctx, portsyncBin+" --verbose", 2*time.Minute, nil)
	if err != nil {
		return "", err
	}
	if res.ExitCode != 0 {
		return res.Stdout + res.Stderr, fmt.Errorf("port-sync завершился с кодом %d", res.ExitCode)
	}
	return res.Stdout, nil
}

// lockPortsync - тот же замок, что берёт port-sync (assets/vps-portsync.py): пока ручные
// правила удаляются по номерам, port-sync не сдвинет нумерацию. Закрытие файла снимает замок.
func lockPortsync() func() {
	f, err := os.OpenFile("/run/vps-portsync.lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return func() {}
	}
	if syscall.Flock(int(f.Fd()), syscall.LOCK_EX) != nil {
		f.Close()
		return func() {}
	}
	return func() { f.Close() }
}
