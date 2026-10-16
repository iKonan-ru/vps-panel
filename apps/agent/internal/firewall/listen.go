// Package firewall читает состояние ufw, слушающие сокеты и DOCKER-USER (правила пишет baseline).
package firewall

import (
	"context"
	"fmt"
	"regexp"
	"slices"
	"strconv"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

var (
	reLocal = regexp.MustCompile(`^(.*):(\d+)$`)
	reProc  = regexp.MustCompile(`\("([^"]+)",`)
)

// socket - слушающий сокет из ss -tulnpH: протокол, адрес, порт и процессы (первый - владелец).
type socket struct {
	proto, addr string
	port        int
	procs       []string
}

func sockets(ctx context.Context) []socket {
	return parseSockets(shell.Out(ctx, "ss", "-tulnpH"))
}

func parseSockets(out string) []socket {
	var res []socket
	for _, line := range strings.Split(out, "\n") {
		f := strings.Fields(line)
		if len(f) < 5 {
			continue
		}
		m := reLocal.FindStringSubmatch(f[4])
		if m == nil {
			continue
		}
		s := socket{proto: f[0], addr: m[1]}
		s.port, _ = strconv.Atoi(m[2])
		for _, pm := range reProc.FindAllStringSubmatch(line, -1) {
			s.procs = append(s.procs, pm[1])
		}
		res = append(res, s)
	}
	return res
}

// Listeners - сокеты, слушающие на внешних адресах, без дублей и без DHCP.
func Listeners(ctx context.Context) []proto.Listener {
	return listeners(sockets(ctx))
}

// ListenersStrict - Listeners, но ss, который не запустился, не завершился вовремя или вышел с
// ошибкой, - ошибка, а не пустой список (по нему port-sync закрыл бы порты).
func ListenersStrict(ctx context.Context) ([]proto.Listener, error) {
	out, code, err := shell.Output(ctx, "ss", "-tulnpH")
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("ss -tulnpH: код %d", code)
	}
	return listeners(parseSockets(out)), nil
}

func listeners(socks []socket) []proto.Listener {
	seen := map[string]bool{}
	res := []proto.Listener{}
	for _, s := range socks {
		if IsLoopback(s.addr) {
			continue
		}
		if s.proto == "udp" && (s.port == 68 || s.port == 546) {
			continue
		}
		procName := ""
		if len(s.procs) > 0 {
			procName = s.procs[0]
		}
		key := s.proto + ":" + strconv.Itoa(s.port) + ":" + procName
		if seen[key] {
			continue
		}
		seen[key] = true
		res = append(res, proto.Listener{Proto: s.proto, Port: s.port, Process: procName})
	}
	return res
}

// IsLoopback - адрес (сокета или listen в настройках) только для этой машины.
func IsLoopback(addr string) bool {
	return strings.HasPrefix(addr, "127.") || addr == "[::1]" || addr == "::1" || strings.HasPrefix(addr, "[::ffff:127.")
}

// PublicPortsOf - порты процесса на внешних адресах (не 127.0.0.1): панель открыта наружу.
func PublicPortsOf(ctx context.Context, procName string) []int {
	var out []int
	for _, s := range sockets(ctx) {
		if !IsLoopback(s.addr) && slices.Contains(s.procs, procName) && !slices.Contains(out, s.port) {
			out = append(out, s.port)
		}
	}
	return out
}

// PortsOf - порты, которые слушает процесс (на любых адресах, и на 127.0.0.1), без повторов.
func PortsOf(ctx context.Context, procName string) []int {
	var out []int
	for _, s := range sockets(ctx) {
		if slices.Contains(s.procs, procName) && !slices.Contains(out, s.port) {
			out = append(out, s.port)
		}
	}
	return out
}

// TCPListening - слушает ли кто-нибудь TCP-порт (на любом адресе): живой ли сервис.
func TCPListening(ctx context.Context, port int) bool {
	for _, s := range sockets(ctx) {
		if s.proto == "tcp" && s.port == port {
			return true
		}
	}
	return false
}
