// Package baseline приводит сервер к эталону: sshd без паролей, fail2ban,
// автообновления, ufw + port-sync. Порт ролей Ansible из vps-orchestrator.
//
// Правила безопасности: docker не перезапускается, ufw reload/disable
// не вызываются, пароли SSH отключаются только если у root есть ключ.
package baseline

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/fsutil"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/sshd"
)

// Явный список: с assets/* в бинарник попадали README и локальный __pycache__ (не из git) -
// сборка зависела от машины.
//
//go:embed assets/vps-portsync.py assets/*.service assets/*.path assets/*.timer
//go:embed assets/*.conf assets/*.jail assets/jail.local assets/50unattended-upgrades
var assets embed.FS

// Step - одна операция эталона в плане.
type Step struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	Needed  bool   `json:"needed"`
	Detail  string `json:"detail,omitempty"`
	Blocker string `json:"blocker,omitempty"` // почему этот шаг сейчас применять нельзя
}

// PortChange - порт, который откроется или закроется после включения firewall.
type PortChange struct {
	Port    int    `json:"port"`
	Proto   string `json:"proto"`
	Process string `json:"process"`
	Action  string `json:"action"` // open | close
}

type Plan struct {
	Steps     []Step       `json:"steps"`
	Ports     []PortChange `json:"ports"`
	Blockers  []string     `json:"blockers"`
	CanApply  bool         `json:"canApply"`
	SSHPort   int          `json:"sshPort"`
	RootKeys  int          `json:"rootKeys"`
	Reasoning string       `json:"reasoning,omitempty"`
}

// MakePlan показывает, что изменится, и какие порты закроются.
func MakePlan(ctx context.Context) Plan {
	ssh := sshd.Config(ctx)
	p := Plan{SSHPort: sshd.Port(ssh), RootKeys: CountRootKeys(), Blockers: []string{}, Ports: []PortChange{}}
	fw := firewall.State(ctx)
	add := func(id, title string, needed bool, detail string) {
		p.Steps = append(p.Steps, Step{ID: id, Title: title, Needed: needed, Detail: detail})
	}
	block := func(id, why string) {
		for i := range p.Steps {
			if p.Steps[i].ID == id {
				p.Steps[i].Blocker = why
			}
		}
		p.Blockers = append(p.Blockers, why)
	}
	pkgs := missingPackages(ctx)
	add("packages", "Установить пакеты: ufw, fail2ban, unattended-upgrades, python3, sqlite3, iptables, conntrack", len(pkgs) > 0, strings.Join(pkgs, ", "))
	needSSH := ssh["passwordauthentication"] != "no" || ssh["permitrootlogin"] == "yes"
	add("sshd", "SSH: отключить вход по паролю, root только по ключу, лимит попыток", needSSH, "")
	if needSSH && p.RootKeys == 0 {
		block("sshd", "у root нет ключей: после отключения паролей доступ к серверу пропадёт")
	}
	add("fail2ban", "fail2ban: jail sshd (и панели 3X-UI, если она нативная)", !shell.Has("fail2ban-client") || shell.Out(ctx, "systemctl", "is-active", "fail2ban") != "active" || !fileHas("/etc/fail2ban/jail.local", "VPS Panel"), "")
	add("updates", "Включить автообновления безопасности (кроме docker и ядра)", !fileHas("/etc/apt/apt.conf.d/50unattended-upgrades", "VPS Panel"), "")
	add("portsync", "Установить port-sync: firewall следует за портами VPN", !fw.PortsyncInstalled || !fw.PortsyncActive, "")
	add("ufw", "Включить firewall (deny incoming, постоянное правило SSH)", !fw.UfwActive, "")

	// Что закроется: слушатели, которых не откроет port-sync.
	cfg := ReadPortsyncConfig()
	allowed, _ := plannedAllow(ctx, cfg)
	for _, l := range fw.Listeners {
		if l.Process == "docker-proxy" {
			continue
		}
		key := listenerKey(l)
		if allowed[key] {
			if !fw.UfwActive {
				p.Ports = append(p.Ports, PortChange{Port: l.Port, Proto: l.Proto, Process: l.Process, Action: "open"})
			}
			continue
		}
		p.Ports = append(p.Ports, PortChange{Port: l.Port, Proto: l.Proto, Process: l.Process, Action: "close"})
	}
	if !fw.UfwActive {
		for _, why := range closingVPN(fw.Listeners, allowed, deniedPorts(cfg), nil) {
			block("ufw", why)
		}
	}
	// применять есть что, если хотя бы один нужный шаг не заблокирован
	for _, st := range p.Steps {
		if st.Needed && st.Blocker == "" {
			p.CanApply = true
		}
	}
	return p
}

// stepOrder - порядок применения: пакеты до всего, port-sync до включения ufw.
var stepOrder = []string{"packages", "sshd", "fail2ban", "updates", "portsync", "ufw"}

// selectSteps выбирает шаги к применению: пустой список = все нужные; зависимости добавляются сами.
func selectSteps(plan Plan, want []string) (map[string]bool, error) {
	sel := map[string]bool{}
	byID := map[string]Step{}
	for _, st := range plan.Steps {
		byID[st.ID] = st
	}
	if len(want) == 0 {
		for _, st := range plan.Steps {
			if st.Needed {
				sel[st.ID] = true
			}
		}
	} else {
		for _, id := range want {
			if _, ok := byID[id]; !ok {
				return nil, fmt.Errorf("неизвестный шаг: %s", id)
			}
			sel[id] = true
		}
	}
	if sel["ufw"] && byID["portsync"].Needed {
		sel["portsync"] = true // без port-sync включённый ufw закроет порты VPN
	}
	if len(sel) > 0 && byID["packages"].Needed {
		sel["packages"] = true
	}
	for id := range sel {
		if b := byID[id].Blocker; b != "" {
			return nil, errors.New(b)
		}
	}
	return sel, nil
}

var vpnHints = []string{"xray", "x-ui", "telemt", "mtproxy", "wdtt", "amnezia", "awg", "wg", "sing-box", "hysteria", "tuic", "openvpn", "cloak"}

func isVPNProcess(name string) bool {
	low := strings.ToLower(name)
	for _, h := range vpnHints {
		if strings.Contains(low, h) {
			return true
		}
	}
	return false
}

func listenerKey(l proto.Listener) string { return fmt.Sprintf("%d/%s", l.Port, l.Proto) }

// deniedPorts - deny_public_ports конфига вида "443/tcp" (без протокола - tcp).
func deniedPorts(cfg PortsyncConfig) map[string]bool {
	denied := map[string]bool{}
	for _, d := range cfg.DenyPublicPorts {
		if !strings.Contains(d, "/") {
			d += "/tcp"
		}
		denied[d] = true
	}
	return denied
}

// closingVPN - порты VPN из listeners, которые port-sync с такими настройками не откроет: по
// замечанию на каждый. Порт из deny-списка закрывается намеренно (9090/9091 - метрики telemt и
// прочих), порт из keep останется открытым другим правилом ufw.
func closingVPN(listeners []proto.Listener, allowed, denied, keep map[string]bool) []string {
	var out []string
	for _, l := range listeners {
		key := listenerKey(l)
		if l.Process == "docker-proxy" || allowed[key] || denied[key] || keep[key] || !isVPNProcess(l.Process) {
			continue
		}
		out = append(out, fmt.Sprintf("порт %s процесса %s закроется, а это похоже на VPN: процесс нужно добавить в известные или порт в разрешённые", key, l.Process))
	}
	return out
}

// plannedAllow - порты, которые port-sync откроет по конфигу. Считаем через
// сам скрипт (--json с конфигом в env), чтобы логика была одна.
func plannedAllow(ctx context.Context, cfg PortsyncConfig) (map[string]bool, error) {
	out := map[string]bool{}
	script, err := assets.ReadFile("assets/vps-portsync.py")
	if err != nil {
		return out, err
	}
	tmp, err := os.CreateTemp("", "portsync-*.py")
	if err != nil {
		return out, err
	}
	defer os.Remove(tmp.Name())
	_, _ = tmp.Write(script)
	tmp.Close()
	cfgJSON, _ := json.Marshal(cfg)
	c, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	// конфиг - через окружение, а не строкой в bash (апострофы и спецсимволы портили бы значения)
	res, err := shell.ExecEnv(c, 60*time.Second, nil, []string{"PORTSYNC_CONF=" + string(cfgJSON)}, "python3", tmp.Name(), "--json")
	if err != nil {
		return out, err
	}
	if res.ExitCode != 0 {
		return out, fmt.Errorf("port-sync --json завершился с кодом %d: %s", res.ExitCode, strings.TrimSpace(res.Stderr))
	}
	var d struct {
		HostAllow   [][]any `json:"host_allow"`
		DockerAllow [][]any `json:"docker_allow"`
	}
	if err := json.Unmarshal([]byte(res.Stdout), &d); err != nil {
		return out, fmt.Errorf("port-sync --json: %w", err)
	}
	for _, pair := range append(d.HostAllow, d.DockerAllow...) {
		if len(pair) == 2 {
			pr, _ := pair[0].(string)
			port, _ := pair[1].(float64)
			out[fmt.Sprintf("%d/%s", int(port), pr)] = true
		}
	}
	return out, nil
}

func fileHas(path, needle string) bool {
	b, err := os.ReadFile(path)
	return err == nil && strings.Contains(string(b), needle)
}

func missingPackages(ctx context.Context) []string {
	var missing []string
	for _, p := range []string{"ufw", "fail2ban", "unattended-upgrades", "python3", "sqlite3", "iptables", "conntrack"} {
		if !shell.OK(ctx, "dpkg", "-s", p) {
			missing = append(missing, p)
		}
	}
	return missing
}

// Apply выполняет эталон, стримит ход работ. Останавливается на первой ошибке.
func Apply(ctx context.Context, steps []string, stream func(channel, chunk string)) error {
	log := func(f string, a ...any) { stream("log", fmt.Sprintf(f, a...)+"\n") }
	plan := MakePlan(ctx)
	sel, err := selectSteps(plan, steps)
	if err != nil {
		return err
	}
	if len(sel) == 0 {
		return errors.New("исправлять нечего")
	}
	var names []string
	for _, id := range stepOrder {
		if sel[id] {
			names = append(names, id)
		}
	}
	log("== Шаги: %s", strings.Join(names, ", "))
	run := func(cmd string) error {
		res, err := shell.Run(ctx, cmd, 15*time.Minute, stream)
		if err != nil {
			return err
		}
		if res.ExitCode != 0 {
			return fmt.Errorf("команда завершилась с кодом %d: %s", res.ExitCode, cmd)
		}
		return nil
	}
	write := func(path string, content []byte, mode os.FileMode) error {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return err
		}
		return fsutil.WriteAtomic(path, content, mode)
	}
	asset := func(name string) []byte {
		b, _ := assets.ReadFile("assets/" + name)
		return b
	}

	// 1. пакеты
	if pk := missingPackages(ctx); sel["packages"] && len(pk) > 0 {
		log("== Пакеты: %s", strings.Join(pk, ", "))
		// dpkg --configure -a чинит полусобранные пакеты, если прошлую установку прервали.
		if err := run(aptWait + "dpkg --configure -a && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get " + aptLock + "install -y -qq " + strings.Join(pk, " ")); err != nil {
			return err
		}
	}

	// 2. sshd
	if sel["sshd"] {
		if err := applySSH(ctx, plan, run, write, asset, log); err != nil {
			return err
		}
	}
	// 3. fail2ban
	if sel["fail2ban"] {
		if err := applyFail2ban(ctx, plan, run, write, asset, log); err != nil {
			return err
		}
	}
	// 4. обновления
	if sel["updates"] {
		if err := applyUpdates(write, asset, log); err != nil {
			return err
		}
	}
	// 5. port-sync + ufw (порядок важен: правила до включения)
	if sel["portsync"] {
		log("== port-sync")
		if err := InstallPortsync(ctx, stream); err != nil {
			return err
		}
		if err := run(portsyncBin + " --verbose"); err != nil {
			return err
		}
		if err := run("systemctl enable --now vps-portsync.timer vps-portsync-xui.path"); err != nil {
			return err
		}
		if _, err := os.Stat("/usr/bin/docker"); err == nil {
			_ = run("systemctl enable --now vps-portsync-docker-watch.service")
		}
	}
	if sel["ufw"] {
		if err := applyUfw(ctx, plan, run, log); err != nil {
			return err
		}
	}
	log("== Готово")
	return nil
}

type runFn = func(cmd string) error

type writeFn = func(path string, content []byte, mode os.FileMode) error

type assetFn = func(name string) []byte

type logFn = func(f string, a ...any)

func applySSH(ctx context.Context, plan Plan, run runFn, write writeFn, asset assetFn, log logFn) error {
	log("== SSH: drop-in без паролей (ключей у root: %d)", plan.RootKeys)
	if plan.RootKeys == 0 {
		return errors.New("у root нет ключей, отключать пароли нельзя")
	}
	// чужие drop-in с PasswordAuthentication yes (cloud-init) - гасим
	if entries, err := os.ReadDir("/etc/ssh/sshd_config.d"); err == nil {
		for _, e := range entries {
			p := "/etc/ssh/sshd_config.d/" + e.Name()
			if e.Name() == "10-vps-panel.conf" {
				continue
			}
			st, err := os.Stat(p)
			if err != nil || !st.Mode().IsRegular() {
				continue
			}
			if b, err := os.ReadFile(p); err == nil && strings.Contains(string(b), "PasswordAuthentication yes") {
				nb := strings.ReplaceAll(string(b), "PasswordAuthentication yes", "# PasswordAuthentication yes (отключено VPS Panel)")
				_ = fsutil.WriteAtomic(p, []byte(nb), st.Mode().Perm())
				log("   отключён PasswordAuthentication yes в %s", p)
			}
		}
	}
	sshConf := strings.ReplaceAll(string(asset("sshd.conf")), "{{SSH_PORT}}", strconv.Itoa(plan.SSHPort))
	if err := write("/etc/ssh/sshd_config.d/10-vps-panel.conf", []byte(sshConf), 0o600); err != nil {
		return err
	}
	if err := run("sshd -t"); err != nil {
		_ = os.Remove("/etc/ssh/sshd_config.d/10-vps-panel.conf")
		return errors.New("sshd -t отверг конфиг, drop-in убран: " + err.Error())
	}
	return run("systemctl restart ssh")
}

func applyFail2ban(ctx context.Context, plan Plan, run runFn, write writeFn, asset assetFn, log logFn) error {
	log("== fail2ban")
	jail := strings.ReplaceAll(string(asset("jail.local")), "{{SSH_PORT}}", strconv.Itoa(plan.SSHPort))
	if err := write("/etc/fail2ban/jail.local", []byte(jail), 0o644); err != nil {
		return err
	}
	if err := write("/etc/fail2ban/filter.d/xui-panel.conf", asset("fail2ban-xui-panel.conf"), 0o644); err != nil {
		return err
	}
	if _, err := os.Stat("/etc/systemd/system/x-ui.service"); err == nil {
		_ = write("/etc/fail2ban/jail.d/xui-panel.conf", asset("xui-panel.jail"), 0o644)
		log("   найден x-ui.service: jail для панели 3X-UI включён")
	} else {
		_ = os.Remove("/etc/fail2ban/jail.d/xui-panel.conf")
	}
	return run("systemctl enable --now fail2ban && systemctl restart fail2ban")
}

func applyUpdates(write writeFn, asset assetFn, log logFn) error {
	log("== Автообновления безопасности")
	if err := write("/etc/apt/apt.conf.d/50unattended-upgrades", asset("50unattended-upgrades"), 0o644); err != nil {
		return err
	}
	return write("/etc/apt/apt.conf.d/20auto-upgrades", []byte("APT::Periodic::Update-Package-Lists \"1\";\nAPT::Periodic::Unattended-Upgrade \"1\";\nAPT::Periodic::AutocleanInterval \"7\";\n"), 0o644)
}

func applyUfw(ctx context.Context, plan Plan, run runFn, log logFn) error {
	log("== ufw")
	for _, c := range []string{"ufw default deny incoming", "ufw default allow outgoing", "ufw logging low",
		fmt.Sprintf("ufw allow %d/tcp comment ssh-permanent", plan.SSHPort)} {
		if err := run(c); err != nil {
			return err
		}
	}
	if err := run(portsyncBin + " --verbose"); err != nil {
		return err
	}
	if !strings.Contains(shell.Out(ctx, "ufw", "status"), "Status: active") {
		if err := run("ufw --force enable"); err != nil {
			return err
		}
	}
	if err := run("systemctl enable --now ufw"); err != nil {
		return err
	}
	// ещё раз после включения - чтобы цепочка DOCKER-USER точно стояла
	return run(portsyncBin + " --verbose")
}
