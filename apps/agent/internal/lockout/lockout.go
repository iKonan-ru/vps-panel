// Package lockout - правила, которые не дают действиям панели отрезать доступ к серверу и VPN:
// пароли SSH без ключей root, удаление последнего ключа, закрытие портов VPN firewall-ом.
package lockout

import (
	"errors"
	"fmt"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
)

// DisablePasswords - можно ли отключить вход по паролю при rootKeys ключах root.
func DisablePasswords(rootKeys int) error {
	if rootKeys == 0 {
		return errors.New("у root нет ключей: после отключения паролей доступ к серверу пропадёт")
	}
	return nil
}

// RemoveKey - можно ли удалить ключ root, если после него останется keysLeft ключей.
func RemoveKey(keysLeft int, passwordLogin bool) error {
	if keysLeft == 0 && !passwordLogin {
		return errors.New("это последний ключ root, а вход по паролю выключен: без него по SSH не войти")
	}
	return nil
}

// vpnProcesses - процессы VPN: known - шаблон в known_processes port-sync по умолчанию ("" - не
// открывать по имени процесса), hint - часть имени, по которой процесс узнаётся как VPN.
var vpnProcesses = []struct{ known, hint string }{
	{"xray*", "xray"}, {"x-ui", "x-ui"}, {"telemt", "telemt"}, {"mtproxyl*", "mtproxy"},
	{"wdtt*", "wdtt"}, {"amnezia*", "amnezia"}, {"awg*", "awg"}, {"wg*", "wg"},
	{"sing-box", "sing-box"}, {"hysteria*", "hysteria"}, {"tuic*", "tuic"}, {"openflux*", "openflux"},
	{"", "openvpn"}, {"", "cloak"},
}

// KnownProcesses - known_processes port-sync по умолчанию: SSH, VPN, сам агент, Caddy и
// docker-proxy.
func KnownProcesses() []string {
	out := []string{"sshd"}
	for _, p := range vpnProcesses {
		if p.known != "" {
			out = append(out, p.known)
		}
	}
	return append(out, "vps-agent", "caddy", "docker-proxy")
}

// IsVPNProcess - похоже ли имя процесса на VPN.
func IsVPNProcess(name string) bool {
	low := strings.ToLower(name)
	for _, p := range vpnProcesses {
		if strings.Contains(low, p.hint) {
			return true
		}
	}
	return false
}

// PortKey - "443/tcp".
func PortKey(l proto.Listener) string { return fmt.Sprintf("%d/%s", l.Port, l.Proto) }

// ClosingVPN - порты VPN из listeners, которые firewall закроет: их нет в allowed (что откроет
// port-sync), deny-списке (закрываются намеренно: 9090/9091 - метрики telemt) и keep (остаются
// открытыми другими правилами). По замечанию на порт.
func ClosingVPN(listeners []proto.Listener, allowed, denied, keep map[string]bool) []string {
	var out []string
	for _, l := range listeners {
		key := PortKey(l)
		if l.Process == "docker-proxy" || allowed[key] || denied[key] || keep[key] || !IsVPNProcess(l.Process) {
			continue
		}
		out = append(out, fmt.Sprintf("порт %s процесса %s закроется, а это похоже на VPN: процесс нужно добавить в известные или порт в разрешённые", key, l.Process))
	}
	return out
}
