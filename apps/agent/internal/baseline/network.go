package baseline

import (
	"context"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Проверка сети после обновления пакетов. postinst пакета systemd перезапускает
// systemd-networkd, и на части хостингов после этого адрес WAN-интерфейса перестаёт быть
// локальным: ответы на него ядро пересылает дальше, DNS и связь с панелью пропадают, и сервер
// остаётся без сети до перезагрузки. Перед обновлением запоминается интерфейс маршрута по
// умолчанию и его адреса IPv4, после - проверяется, что маршрут на месте и каждый адрес
// локальный (ip route get отвечает "local"); если нет - networkctl reconfigure, затем netplan apply.

// netState - интерфейс маршрута по умолчанию и его глобальные адреса IPv4.
type netState struct {
	dev   string
	addrs []string
}

// wanState снимает netState; пустой dev - маршрута по умолчанию нет (проверять нечего).
func wanState(ctx context.Context) netState {
	dev := defaultDev(shell.Out(ctx, "ip", "-4", "route", "show", "default"))
	if dev == "" {
		return netState{}
	}
	return netState{dev: dev, addrs: inetAddrs(shell.Out(ctx, "ip", "-4", "-o", "addr", "show", "dev", dev, "scope", "global"))}
}

// defaultDev - имя интерфейса из вывода "ip -4 route show default" (первый маршрут).
func defaultDev(out string) string {
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 || f[0] != "default" {
			continue
		}
		for i := 1; i+1 < len(f); i++ {
			if f[i] == "dev" {
				return f[i+1]
			}
		}
	}
	return ""
}

// inetAddrs - адреса без префикса из вывода "ip -4 -o addr show".
func inetAddrs(out string) []string {
	var addrs []string
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		for i := 0; i+1 < len(f); i++ {
			if f[i] == "inet" {
				a, _, _ := strings.Cut(f[i+1], "/")
				addrs = append(addrs, a)
				break
			}
		}
	}
	return addrs
}

// isLocalRoute - вывод "ip -4 route get <адрес>" для адреса самого сервера.
func isLocalRoute(out string) bool {
	return strings.HasPrefix(strings.TrimSpace(out), "local ")
}

// netProblem - что не так с сетью относительно снимка; пусто - всё на месте.
func netProblem(ctx context.Context, st netState) string {
	if dev := defaultDev(shell.Out(ctx, "ip", "-4", "route", "show", "default")); dev == "" {
		return "нет маршрута по умолчанию"
	}
	for _, a := range st.addrs {
		if !isLocalRoute(shell.Out(ctx, "ip", "-4", "route", "get", a)) {
			return "адрес " + a + " больше не локальный (" + st.dev + ")"
		}
	}
	return ""
}

// waitNetwork - до limit ждёт, пока netProblem не станет пустым; возвращает последнюю проблему.
func waitNetwork(ctx context.Context, st netState, limit time.Duration) string {
	end := time.Now().Add(limit)
	for {
		p := netProblem(ctx, st)
		if p == "" || time.Now().After(end) {
			return p
		}
		time.Sleep(3 * time.Second)
	}
}

// ensureNetwork проверяет сеть после обновления и чинит её, если она пропала.
func ensureNetwork(st netState, log func(string, ...any)) {
	if st.dev == "" {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	// networkd мог ещё не дойти до конца настройки после перезапуска
	p := waitNetwork(ctx, st, 15*time.Second)
	if p == "" {
		return
	}
	log("== Сеть после обновления: %s - восстанавливаю", p)
	if shell.Has("networkctl") && shell.OK(ctx, "systemctl", "is-active", "--quiet", "systemd-networkd") {
		log("networkctl reconfigure %s", st.dev)
		_, _ = shell.Exec(ctx, 30*time.Second, nil, "networkctl", "reconfigure", st.dev)
		if p = waitNetwork(ctx, st, 20*time.Second); p == "" {
			log("Сеть восстановлена")
			return
		}
	}
	if shell.Has("netplan") {
		log("netplan apply")
		_, _ = shell.Exec(ctx, time.Minute, nil, "netplan", "apply")
		if p = waitNetwork(ctx, st, 30*time.Second); p == "" {
			log("Сеть восстановлена")
			return
		}
	}
	log("ВНИМАНИЕ: сеть не восстановилась (%s). Перезагрузите сервер из панели хостинга или выполните в его консоли: netplan apply", p)
}
