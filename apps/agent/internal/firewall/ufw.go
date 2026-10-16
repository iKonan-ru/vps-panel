package firewall

import (
	"context"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/proto"
	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// reRule разбирает строку `ufw status verbose`:
// "443/tcp                    ALLOW IN    Anywhere                   # comment"
var reRule = regexp.MustCompile(`^(\S+)\s+(ALLOW|DENY|REJECT|LIMIT)\s+(IN|OUT|FWD)?\s*(\S.*?)\s*(#\s*(.*))?$`)

// State собирает полное состояние firewall для inventory.
func State(ctx context.Context) proto.FirewallState {
	st := proto.FirewallState{Rules: []proto.FirewallRule{}, Listeners: []proto.Listener{}}
	if shell.Has("ufw") {
		out := shell.Out(ctx, "ufw", "status", "verbose")
		st.UfwActive = strings.Contains(out, "Status: active")
		for _, line := range strings.Split(out, "\n") {
			if strings.HasPrefix(line, "Default:") {
				st.DefaultIncoming = strings.TrimSpace(strings.TrimPrefix(line, "Default:"))
			}
			if r, ok := parseRule(line); ok {
				st.Rules = append(st.Rules, r)
			}
		}
	}
	st.Listeners = Listeners(ctx)
	// Порт открыт, если ufw неактивен, либо есть allow-правило на него.
	allowed := AllowedByRules(st.Rules, nil)
	for i := range st.Listeners {
		l := &st.Listeners[i]
		key := itoa(l.Port) + "/" + l.Proto
		l.Open = !st.UfwActive || allowed[key] || l.Process == "docker-proxy"
	}
	st.DockerFiltered = strings.Contains(shell.Out(ctx, "iptables", "-w", "5", "-S", "DOCKER-USER"), "-j VPS-PORTSYNC")
	if _, err := os.Stat("/usr/local/sbin/vps-portsync"); err == nil {
		st.PortsyncInstalled = true
		st.PortsyncActive = shell.Out(ctx, "systemctl", "is-active", "vps-portsync.timer") == "active"
		if fi, err := os.Stat("/var/lib/vps-portsync/last.json"); err == nil {
			st.PortsyncLastRun = fi.ModTime().UTC().Format("2006-01-02T15:04:05Z")
		}
	}
	return st
}

// AllowedByRules - порты ("443/tcp"), открытые всем allow-правилами из rules; only - какие
// правила учитывать (nil - все).
func AllowedByRules(rules []proto.FirewallRule, only func(proto.FirewallRule) bool) map[string]bool {
	allowed := map[string]bool{}
	for _, r := range rules {
		if r.Action != "allow" || r.Source != "any" || (only != nil && !only(r)) {
			continue
		}
		for _, p := range expandPorts(r.Port) {
			allowed[p+"/"+r.Proto] = true
			if r.Proto == "any" {
				allowed[p+"/tcp"] = true
				allowed[p+"/udp"] = true
			}
		}
	}
	return allowed
}

func parseRule(line string) (proto.FirewallRule, bool) {
	line = strings.TrimSpace(line)
	if line == "" || strings.HasPrefix(line, "To ") || strings.HasPrefix(line, "--") || strings.HasPrefix(line, "Status") {
		return proto.FirewallRule{}, false
	}
	m := reRule.FindStringSubmatch(line)
	if m == nil || strings.Contains(m[1], "(v6)") {
		return proto.FirewallRule{}, false
	}
	if m[3] == "OUT" || m[3] == "FWD" {
		return proto.FirewallRule{}, false
	}
	port, pr := m[1], "any"
	if i := strings.Index(port, "/"); i > 0 {
		pr = port[i+1:]
		port = port[:i]
	}
	if port == "Anywhere" {
		return proto.FirewallRule{}, false
	}
	src := strings.TrimSpace(strings.TrimSuffix(m[4], "(v6)"))
	if src == "Anywhere" || src == "" {
		src = "any"
	}
	action := strings.ToLower(m[2])
	if action == "reject" || action == "limit" {
		action = map[string]string{"reject": "deny", "limit": "allow"}[action]
	}
	comment := strings.TrimSpace(m[6])
	r := proto.FirewallRule{Port: port, Proto: pr, Source: src, Action: action, Comment: comment, Origin: "manual"}
	switch {
	case strings.HasPrefix(comment, "panel:"):
		r.Origin = "manual"
		r.ManualID = strings.TrimPrefix(comment, "panel:")
		r.Comment = ""
	case comment == "vps-portsync":
		r.Origin = "portsync"
		r.Comment = ""
	case strings.HasPrefix(comment, "vps-portsync: "):
		// port-sync 0.3.2+: подпись - какой сервис открыл порт
		r.Origin = "portsync"
		r.Comment = strings.TrimPrefix(comment, "vps-portsync: ")
	case comment == "ssh-permanent" || comment == "ssh-admin":
		r.Origin = "permanent"
	}
	return r, true
}

func expandPorts(p string) []string {
	var out []string
	for _, part := range strings.Split(p, ",") {
		part = strings.TrimSpace(part)
		if a, b, ok := strings.Cut(part, ":"); ok {
			out = append(out, a, b)
			continue
		}
		out = append(out, part)
	}
	return out
}

func itoa(i int) string { return strconv.Itoa(i) }
