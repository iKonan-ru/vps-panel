package adapters

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/dockerapi"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/firewall"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// Подробный список подключений сервера (conns.list): кто и на какие порты подключён сейчас.
// Только чтение: адреса клиентов уходят панели администратора, в метрики и журналы - нет.

// maxConnAddrs - адресов в ответе; остальные отрезаются (truncated), самые нагруженные остаются.
const maxConnAddrs = 300

// ConnPort - соединения одного адреса на одном порту.
type ConnPort struct {
	Port  int `json:"port"`
	Conns int `json:"conns"`
}

// ConnAddr - адрес клиента: соединения по портам и пользователи xray, которым он принадлежит.
type ConnAddr struct {
	IP    string     `json:"ip"`
	Conns int        `json:"conns"`
	Ports []ConnPort `json:"ports"`
	Users []string   `json:"users"`
}

// ConnListener - внешний TCP-порт сервиса: процесс-владелец и сколько на нём соединений и адресов.
type ConnListener struct {
	Port    int    `json:"port"`
	Process string `json:"process"`
	Conns   int    `json:"conns"`
	IPs     int    `json:"ips"`
}

// ConnAwg - пир AWG с недавним handshake и адрес, с которого он пришёл.
type ConnAwg struct {
	Container string `json:"container"`
	Key       string `json:"key"`
	IP        string `json:"ip"`
	Handshake int64  `json:"handshake"`
	Rx        int64  `json:"rx"`
	Tx        int64  `json:"tx"`
}

// ConnsList - ответ conns.list.
type ConnsList struct {
	At        int64             `json:"at"`
	Listeners []ConnListener    `json:"listeners"`
	Addrs     []ConnAddr        `json:"addrs"`
	Awg       []ConnAwg         `json:"awg"`
	Truncated bool              `json:"truncated"`
	Errors    map[string]string `json:"errors"`
}

// ConnsListAll собирает подробный список подключений.
func ConnsListAll(ctx context.Context) ConnsList {
	out := ConnsList{Listeners: []ConnListener{}, Addrs: []ConnAddr{}, Awg: []ConnAwg{}, Errors: map[string]string{}}
	procs := firewall.PublicTCPProcs(ctx, "sshd")
	var wg sync.WaitGroup
	var awg []ConnAwg
	var awgErr error
	wg.Add(1)
	go func() {
		defer wg.Done()
		c, cancel := context.WithTimeout(ctx, statsTimeout)
		defer cancel()
		awg, awgErr = awgActivePeers(c, time.Now())
	}()
	users := xrayOnlineUsers(ctx)
	text := shell.Out(ctx, "ss", "-Htn", "state", "established")
	out.Addrs, out.Listeners = connAddrs(text, procs, users)
	if len(out.Addrs) > maxConnAddrs {
		out.Addrs, out.Truncated = out.Addrs[:maxConnAddrs], true
	}
	wg.Wait()
	if awgErr != nil && !errors.Is(awgErr, errNotInstalled) {
		out.Errors["awg"] = awgErr.Error()
	}
	out.Awg = awg
	if out.Awg == nil {
		out.Awg = []ConnAwg{}
	}
	out.At = time.Now().UnixMilli()
	return out
}

// connAddrs - установленные TCP к портам procs из "ss -Htn state established", сгруппированные
// по адресу клиента (loopback пропускается), и по портам; users - email пользователей xray по
// активным адресам. Самые нагруженные первыми.
func connAddrs(text string, procs map[int]string, users map[string][]string) ([]ConnAddr, []ConnListener) {
	byIP := map[string]map[int]int{}
	for _, line := range strings.Split(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 4 {
			continue
		}
		i := strings.LastIndex(f[2], ":")
		if i < 0 {
			continue
		}
		port, err := strconv.Atoi(f[2][i+1:])
		if err != nil {
			continue
		}
		if _, ok := procs[port]; !ok {
			continue
		}
		ip := peerIP(f[3])
		if ip == "" {
			continue
		}
		if byIP[ip] == nil {
			byIP[ip] = map[int]int{}
		}
		byIP[ip][port]++
	}
	owners := map[string][]string{}
	for email, ips := range users {
		for _, ip := range ips {
			owners[ip] = append(owners[ip], email)
		}
	}
	portConns, portIPs := map[int]int{}, map[int]int{}
	addrs := make([]ConnAddr, 0, len(byIP))
	for ip, ports := range byIP {
		a := ConnAddr{IP: ip, Ports: []ConnPort{}, Users: append([]string{}, owners[ip]...)}
		sort.Strings(a.Users)
		for port, n := range ports {
			a.Conns += n
			a.Ports = append(a.Ports, ConnPort{Port: port, Conns: n})
			portConns[port] += n
			portIPs[port]++
		}
		sort.Slice(a.Ports, func(i, j int) bool {
			if a.Ports[i].Conns != a.Ports[j].Conns {
				return a.Ports[i].Conns > a.Ports[j].Conns
			}
			return a.Ports[i].Port < a.Ports[j].Port
		})
		addrs = append(addrs, a)
	}
	sort.Slice(addrs, func(i, j int) bool {
		if addrs[i].Conns != addrs[j].Conns {
			return addrs[i].Conns > addrs[j].Conns
		}
		return addrs[i].IP < addrs[j].IP
	})
	listeners := make([]ConnListener, 0, len(procs))
	for port, proc := range procs {
		listeners = append(listeners, ConnListener{Port: port, Process: proc, Conns: portConns[port], IPs: portIPs[port]})
	}
	sort.Slice(listeners, func(i, j int) bool {
		if listeners[i].Conns != listeners[j].Conns {
			return listeners[i].Conns > listeners[j].Conns
		}
		return listeners[i].Port < listeners[j].Port
	})
	return addrs, listeners
}

// awgActivePeers - пиры AWG с handshake за awgActiveWindow и адрес их endpoint.
func awgActivePeers(ctx context.Context, now time.Time) ([]ConnAwg, error) {
	if !dockerapi.Available() {
		return nil, errNotInstalled
	}
	list, err := dockerapi.New().List(ctx)
	if list == nil {
		return nil, err
	}
	var out []ConnAwg
	var errs []string
	for _, c := range list {
		if !reAwgContainer.MatchString(c.Name) || c.State != "running" {
			continue
		}
		res, err := awgDocker(ctx, statsTimeout, nil, "exec", c.Name, "sh", "-c",
			"awg show all dump 2>/dev/null || wg show all dump")
		if err != nil || res.ExitCode != 0 {
			errs = append(errs, c.Name+": "+firstLine(res.Stderr, fmt.Sprint(err)))
			continue
		}
		out = append(out, parseAwgActive(c.Name, res.Stdout, now)...)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Handshake > out[j].Handshake })
	if len(errs) > 0 {
		return out, errors.New(strings.Join(errs, "; "))
	}
	return out, nil
}

// parseAwgActive - строки пиров "awg show all dump" контейнера с handshake за awgActiveWindow.
func parseAwgActive(container, text string, now time.Time) []ConnAwg {
	var out []ConnAwg
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		f := strings.Split(line, "\t")
		if len(f) < 2 {
			continue
		}
		pub, s, ok := awgPeerFields(f[1:])
		if !ok || s.handshake <= 0 || now.Sub(time.Unix(s.handshake, 0)) > awgActiveWindow {
			continue
		}
		out = append(out, ConnAwg{Container: container, Key: pub, IP: peerIP(s.endpoint), Handshake: s.handshake, Rx: s.rx, Tx: s.tx})
	}
	return out
}
