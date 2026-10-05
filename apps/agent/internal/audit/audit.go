// Package audit - проверка безопасности сервера, порт vps-audit.py. Только чтение.
package audit

import (
	"context"
	"os"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/baseline"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/sshd"
)

// Кэш числа обновлений: apt-get -s upgrade идёт около секунды, а меняется редко.
var (
	updMu  sync.Mutex
	updAt  time.Time
	updN   int
	updTTL = 10 * time.Minute
)

// PendingUpdates - число ожидающих обновлений безопасности (apt-get -s upgrade), с кэшем на 10 минут.
func PendingUpdates(ctx context.Context) int {
	updMu.Lock()
	defer updMu.Unlock()
	if time.Since(updAt) < updTTL {
		return updN
	}
	n := 0
	for _, l := range strings.Split(shell.Out(ctx, "apt-get", "-s", "upgrade"), "\n") {
		if strings.HasPrefix(l, "Inst ") && strings.Contains(l, "security") {
			n++
		}
	}
	updN, updAt = n, time.Now()
	return n
}

// InvalidateUpdates сбрасывает кэш: после apt upgrade или приведения к эталону.
func InvalidateUpdates() {
	updMu.Lock()
	updAt = time.Time{}
	updMu.Unlock()
}

// Run собирает факты и находки. fw, services, certs и pendingUpdates уже собраны inventory.
func Run(ctx context.Context, fw proto.FirewallState, containers []proto.Container, services []proto.Service, certs []proto.Cert, pendingUpdates int) proto.Audit {
	a := proto.Audit{Findings: []proto.Finding{}, Fail2banJails: []string{}, Jails: []proto.Jail{}}
	add := func(sev, text, fix string) {
		a.Findings = append(a.Findings, proto.Finding{Severity: sev, Text: text, Fix: fix})
	}
	addURL := func(sev, text, fix, url string) {
		a.Findings = append(a.Findings, proto.Finding{Severity: sev, Text: text, Fix: fix, URL: url})
	}

	// --- sshd
	ssh := sshd.Config(ctx)
	a.SSHPort = sshd.Port(ssh)
	a.SSHPasswordAuth = ssh["passwordauthentication"] != "no"
	a.SSHPermitRootLogin = ssh["permitrootlogin"]
	if a.SSHPasswordAuth {
		addURL("high", "SSH: вход по паролю включён", "Исправить: отключить пароли, оставить вход по ключу", "fix:sshd")
	}
	if a.SSHPermitRootLogin == "yes" {
		addURL("high", "SSH: PermitRootLogin yes - root может войти по паролю", "Исправить: prohibit-password", "fix:sshd")
	}
	if baseline.CountRootKeys() == 0 && !a.SSHPasswordAuth {
		add("high", "SSH: у root нет ключей, а пароли выключены - риск потерять доступ", "Кнопка \"Ключи root\" выше")
	}

	// --- firewall
	switch {
	case !shell.Has("ufw"):
		addURL("high", "ufw не установлен", "Исправить: установить и включить firewall", "fix:ufw")
	case !fw.UfwActive:
		addURL("high", "Firewall (ufw) не активен", "Исправить: включить firewall", "fix:ufw")
	case !strings.Contains(fw.DefaultIncoming, "deny (incoming)"):
		addURL("high", "ufw: входящие по умолчанию не запрещены: "+fw.DefaultIncoming, "Исправить: deny incoming", "fix:ufw")
	}
	published := false
	for _, c := range containers {
		if c.State == "running" && len(c.Published) > 0 && c.NetworkMode != "host" {
			published = true
		}
	}
	if published && fw.UfwActive && !fw.DockerFiltered {
		addURL("high", "Опубликованные порты контейнеров идут мимо ufw: цепочка DOCKER-USER не фильтруется", "Исправить: port-sync настроит DOCKER-USER", "fix:portsync")
	}
	if !fw.PortsyncInstalled {
		addURL("high", "port-sync не установлен: firewall не следит за портами VPN", "Исправить: установить port-sync", "fix:portsync")
	} else if !fw.PortsyncActive {
		addURL("medium", "port-sync установлен, но таймер не активен", "Исправить: включить таймер", "fix:portsync")
	}

	// --- fail2ban
	if !shell.Has("fail2ban-client") {
		addURL("high", "fail2ban не установлен", "Исправить: установить fail2ban", "fix:fail2ban")
	} else {
		a.Fail2banRunning = shell.Out(ctx, "systemctl", "is-active", "fail2ban") == "active"
		if !a.Fail2banRunning {
			addURL("high", "fail2ban установлен, но не запущен", "Исправить: запустить fail2ban", "fix:fail2ban")
		} else {
			out := shell.Out(ctx, "fail2ban-client", "status")
			if m := regexp.MustCompile(`Jail list:\s*(.*)`).FindStringSubmatch(out); m != nil {
				for _, j := range strings.Split(m[1], ",") {
					if j = strings.TrimSpace(j); j != "" {
						a.Fail2banJails = append(a.Fail2banJails, j)
					}
				}
			}
			if !slices.Contains(a.Fail2banJails, "sshd") {
				addURL("medium", "fail2ban: нет jail для sshd", "Исправить: настроить jail", "fix:fail2ban")
			}
			for _, j := range a.Fail2banJails {
				st := shell.Out(ctx, "fail2ban-client", "status", j)
				a.Jails = append(a.Jails, proto.Jail{
					Name:        j,
					Banned:      statInt(st, "Currently banned"),
					TotalBanned: statInt(st, "Total banned"),
					Failed:      statInt(st, "Currently failed"),
					BannedIPs:   bannedList(st),
				})
			}
		}
	}

	// --- сервисы работают, а не только установлены (services/health.go). Текст замечания
	// постоянный: по нему панель шлёт "критичные замечания" и "замечания закрыты"; причина -
	// в fix.
	for _, s := range services {
		if down, _ := s.Details["down"].(bool); down {
			reason, _ := s.Details["downReason"].(string)
			text, fix, url := downFinding(s, reason)
			addURL("high", text, fix, url)
		}
	}

	// --- панели сервисов: только 127.0.0.1, вход - через поддомен VPS
	// Panel (её вход и HTTPS); открытая наружу панель - замечание с командой, которая это чинит
	for _, s := range services {
		if (s.Kind != "xui" && s.Kind != "mtproxyl") || s.Details == nil {
			continue
		}
		if partial, _ := s.Details["partial"].(string); partial != "" {
			add("info", partial, "")
			continue
		}
		if public, _ := s.Details["panelPublic"].(bool); public {
			title := "3X-UI"
			if s.Kind == "mtproxyl" {
				title = "MTProxyL"
			}
			addURL("high", "Панель "+title+" открыта наружу: её можно найти сканером и подбирать пароль", "Оставить только 127.0.0.1 - вход через VPS Panel", "cmd:panels-local")
		}
	}
	for _, c := range containers {
		if c.State != "running" {
			continue
		}
		low := strings.ToLower(c.Name)
		for _, hint := range []string{"wg-easy", "portainer", "grafana", "prometheus"} {
			if strings.Contains(low, hint) {
				for _, p := range c.Published {
					if strings.Contains(p, "/tcp") && !strings.HasPrefix(p, "127.") {
						addURL("medium", "Контейнер "+c.Name+" публикует веб-панель наружу: "+p, "Вкладка Firewall: deny-список или правило с источником", "tab:firewall")
					}
				}
			}
		}
	}

	// --- обновления
	conf, _ := os.ReadFile("/etc/apt/apt.conf.d/20auto-upgrades")
	a.UnattendedUpgrades = strings.Contains(string(conf), `Unattended-Upgrade "1"`)
	if !a.UnattendedUpgrades {
		addURL("medium", "Автообновления безопасности выключены", "Исправить: включить unattended-upgrades", "fix:updates")
	}
	a.PendingUpdates = pendingUpdates
	if a.PendingUpdates > 0 {
		add("medium", "Ожидают установки обновления безопасности: "+strconv.Itoa(a.PendingUpdates), "Кнопка \"Обновить пакеты\" выше")
	}
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		a.RebootRequired = true
		add("info", "Требуется перезагрузка (обновлено ядро или libc)", "Кнопка \"Перезагрузить\" выше: VPN прервётся на минуту, лучше когда пользователей меньше")
	}
	// --- диск: от 80% - предупреждение, от 90% - критично; кнопка ведёт к очистке мусора
	var st syscall.Statfs_t
	if err := syscall.Statfs("/", &st); err == nil && st.Blocks > 0 {
		used := 100 - int(st.Bavail*100/st.Blocks)
		if used >= 90 {
			addURL("high", "Диск заполнен на "+strconv.Itoa(used)+"%", "Освободить место", "cleanup:")
		} else if used >= 80 {
			addURL("medium", "Диск заполнен на "+strconv.Itoa(used)+"%", "Освободить место", "cleanup:")
		}
	}
	return a
}

// statInt достаёт число из строки вида "|- Currently banned:\t3" в выводе fail2ban-client.
// bannedList - адреса из строки "Banned IP list:" вывода fail2ban-client status <jail>.
func bannedList(st string) []string {
	out := []string{}
	m := regexp.MustCompile(`Banned IP list:\s*(.*)`).FindStringSubmatch(st)
	if m == nil {
		return out
	}
	for _, ip := range strings.Fields(m[1]) {
		if len(out) >= 100 {
			break
		}
		out = append(out, ip)
	}
	return out
}

func statInt(out, label string) int {
	m := regexp.MustCompile(label + `:\s*(\d+)`).FindStringSubmatch(out)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

// downFinding - замечание об упавшем сервисе: текст, что сделать и куда перейти в панели.
func downFinding(s proto.Service, reason string) (text, fix, url string) {
	with := func(action string) string {
		if reason == "" {
			return action
		}
		return capital(reason) + ". " + action
	}
	switch s.Kind {
	case "xui":
		return "3X-UI: xray не работает - VLESS на сервере недоступен",
			with("Исправить inbound в панели 3X-UI (например, порт занят другим сервисом) - xray запустится сам"), "tab:xui"
	case "mtproxyl":
		return "MTProxyL: прокси не работает - Telegram-прокси недоступен",
			with("Вкладка MTProxyL: \"Перезапустить прокси\""), "tab:mtproxyl"
	case "amnezia":
		return s.Title + ": контейнер не работает - клиенты AWG без связи",
			with("Вкладка Docker: запустить контейнер"), "tab:docker"
	case "wg-easy":
		return "wg-easy: контейнер не работает - клиенты без связи",
			with("Вкладка Docker: запустить контейнер"), "tab:docker"
	case "openflux":
		return "OpenFlux: канал не работает - узел недоступен",
			with("Вкладка \"Терминал\": systemctl restart openflux-node@<канал>, причина - journalctl -u openflux-node@<канал>"), "tab:terminal"
	case "wdtt":
		return "WDTT: служба не работает - клиенты WDTT без связи",
			with("Вкладка \"Терминал\": systemctl restart wdtt, причина - journalctl -u wdtt"), "tab:terminal"
	default:
		return s.Title + ": не работает",
			with("Вкладка \"Терминал\": wg-quick up <имя> (awg-quick для AWG)"), "tab:terminal"
	}
}

// capital - первая буква заглавная ("порт ..." -> "Порт ...").
func capital(s string) string {
	r := []rune(s)
	if len(r) > 0 {
		r[0] = []rune(strings.ToUpper(string(r[0])))[0]
	}
	return string(r)
}
