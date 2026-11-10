package adapters

import (
	"context"
	"errors"
	"net/netip"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// ConnsKillRequest - адрес, соединения которого сбрасываются.
type ConnsKillRequest struct {
	IP string `json:"ip"`
}

// ConnsKillResult - сколько соединений адреса было и осталось и чем сброшены.
type ConnsKillResult struct {
	Before int    `json:"before"`
	After  int    `json:"after"`
	Method string `json:"method"`
}

// ConnsKill сбрасывает установленные TCP-соединения с адресом: ss -K (нужен CONFIG_INET_DIAG_DESTROY
// в ядре), а если остались - conntrack -D. Правило firewall этого не делает: ufw пропускает уже
// установленные соединения раньше своих правил.
func ConnsKill(ctx context.Context, req ConnsKillRequest) (ConnsKillResult, error) {
	addr, err := netip.ParseAddr(strings.TrimSpace(req.IP))
	if err != nil || addr.IsLoopback() || addr.IsUnspecified() {
		return ConnsKillResult{}, errors.New("неверный адрес")
	}
	ip := addr.Unmap().String()
	res := ConnsKillResult{Before: countPeer(ctx, ip)}
	if res.Before == 0 {
		return res, nil
	}
	if r, err := shell.Exec(ctx, 20*time.Second, nil, "ss", "-K", "dst", ip); err == nil && r.ExitCode == 0 {
		res.Method = "ss"
	}
	res.After = countPeer(ctx, ip)
	if res.After > 0 && shell.Has("conntrack") {
		_ = shell.OK(ctx, "conntrack", "-D", "-s", ip)
		res.Method = strings.TrimPrefix(res.Method+"+conntrack", "+")
		res.After = countPeer(ctx, ip)
	}
	return res, nil
}

// countPeer - установленные TCP-соединения с адресом.
func countPeer(ctx context.Context, ip string) int {
	n := 0
	for _, line := range strings.Split(shell.Out(ctx, "ss", "-Htn", "state", "established", "dst", ip), "\n") {
		if len(strings.Fields(line)) >= 4 {
			n++
		}
	}
	return n
}
