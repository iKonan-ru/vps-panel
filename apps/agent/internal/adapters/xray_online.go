package adapters

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// xuiBinDir - каталог xray из 3X-UI: бинарник xray-linux-<arch> и config.json (переменная - для тестов).
var xuiBinDir = "/usr/local/x-ui/bin"

// xrayOnlineWindow - адрес пользователя считается активным, если он был виден не раньше.
const xrayOnlineWindow = 2 * time.Minute

// xrayOnlineTTL - xray спрашивается через его CLI: не чаще раза в 10 секунд.
const xrayOnlineTTL = 10 * time.Second

var xrayOnline struct {
	sync.Mutex
	users map[string][]string
	at    time.Time
}

// xrayAPIAddr - адрес gRPC API xray из inbound с тегом api в config.json; пусто - API нет.
func xrayAPIAddr() string {
	b, err := os.ReadFile(filepath.Join(xuiBinDir, "config.json"))
	if err != nil {
		return ""
	}
	var c struct {
		Inbounds []struct {
			Tag    string `json:"tag"`
			Listen string `json:"listen"`
			Port   int    `json:"port"`
		} `json:"inbounds"`
	}
	if json.Unmarshal(b, &c) != nil {
		return ""
	}
	for _, in := range c.Inbounds {
		if in.Tag == "api" && in.Port > 0 {
			host := in.Listen
			if host == "" {
				host = "127.0.0.1"
			}
			return host + ":" + strconv.Itoa(in.Port)
		}
	}
	return ""
}

// parseXrayOnlineIPs - ответ "xray api statsonlineiplist -all": email -> адреса, виденные не
// раньше since (unix с).
func parseXrayOnlineIPs(raw []byte, since int64) map[string][]string {
	var resp struct {
		Users []struct {
			Email string `json:"email"`
			IPs   []struct {
				IP       string `json:"ip"`
				LastSeen int64  `json:"lastSeen"`
			} `json:"ips"`
		} `json:"users"`
	}
	out := map[string][]string{}
	if json.Unmarshal(raw, &resp) != nil {
		return out
	}
	for _, u := range resp.Users {
		for _, ip := range u.IPs {
			if ip.LastSeen >= since {
				out[u.Email] = append(out[u.Email], ip.IP)
			}
		}
	}
	return out
}

// xrayOnlineUsers - пользователи xray 3X-UI и их активные адреса. Нет xray, API или команды в этой
// версии - пусто: счётчик по клиентам не показывается, остальное работает.
func xrayOnlineUsers(ctx context.Context) map[string][]string {
	xrayOnline.Lock()
	defer xrayOnline.Unlock()
	if time.Since(xrayOnline.at) < xrayOnlineTTL {
		return xrayOnline.users
	}
	xrayOnline.at = time.Now()
	xrayOnline.users = nil
	bins, _ := filepath.Glob(filepath.Join(xuiBinDir, "xray-linux-*"))
	addr := xrayAPIAddr()
	if len(bins) == 0 || addr == "" {
		return nil
	}
	c, cancel := context.WithTimeout(ctx, statsTimeout)
	defer cancel()
	out, code, err := shell.Output(c, bins[0], "api", "statsonlineiplist", "-s", addr, "-all")
	if err != nil || code != 0 {
		return nil
	}
	xrayOnline.users = parseXrayOnlineIPs([]byte(out), time.Now().Add(-xrayOnlineWindow).Unix())
	return xrayOnline.users
}

// userConn - соединения пользователя xray и число его активных адресов.
type userConn struct {
	Ref   string
	Conns int
	IPs   int
}

// userConns - соединения по пользователям xray: соединения адреса делятся поровну между
// пользователями, у которых он активен (общий NAT), самые нагруженные первыми.
func userConns(users map[string][]string, byIP map[string]int) []userConn {
	owners := map[string]int{}
	for _, ips := range users {
		for _, ip := range ips {
			owners[ip]++
		}
	}
	var out []userConn
	for ref, ips := range users {
		share := 0.0
		n := 0
		for _, ip := range ips {
			if c := byIP[ip]; c > 0 {
				share += float64(c) / float64(owners[ip])
				n++
			}
		}
		if n > 0 {
			out = append(out, userConn{Ref: ref, Conns: int(share + 0.5), IPs: n})
		}
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Conns != out[j].Conns {
			return out[i].Conns > out[j].Conns
		}
		return out[i].Ref < out[j].Ref
	})
	return out
}
