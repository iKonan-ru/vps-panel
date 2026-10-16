package baseline

import (
	"context"
	"errors"
	"fmt"
	"net/netip"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// EnableFirewall: port-sync, затем ufw enable. Без reload.
func EnableFirewall(ctx context.Context, stream func(channel, chunk string)) error {
	if _, err := os.Stat(portsyncBin); err != nil {
		return errors.New("port-sync не установлен: сначала нужно привести сервер к эталону")
	}
	plan := MakePlan(ctx)
	// блокер именно шагов ufw и port-sync: общий CanApply бывает true, когда ufw заблокирован, а
	// нужен другой шаг
	for _, st := range plan.Steps {
		if (st.ID == "ufw" || st.ID == "portsync") && st.Blocker != "" {
			return errors.New(st.Blocker)
		}
	}
	for _, c := range []string{"ufw default deny incoming", "ufw default allow outgoing",
		fmt.Sprintf("ufw allow %d/tcp comment ssh-permanent", plan.SSHPort), portsyncBin + " --verbose", "ufw --force enable", portsyncBin + " --verbose"} {
		res, err := shell.Run(ctx, c, 2*time.Minute, stream)
		if err != nil || res.ExitCode != 0 {
			return fmt.Errorf("не удалось: %s", c)
		}
	}
	return nil
}

// DisableFirewall: ufw disable сносит правила docker, поэтому по требованию
// перезапускается docker (это разрывает VPN-сессии - UI предупреждает).
func DisableFirewall(ctx context.Context, restartDocker bool, stream func(channel, chunk string)) error {
	res, err := shell.Run(ctx, "ufw disable", time.Minute, stream)
	if err != nil || res.ExitCode != 0 {
		return errors.New("ufw disable не удался")
	}
	if restartDocker {
		if _, err := os.Stat("/usr/bin/docker"); err == nil {
			_, _ = shell.Run(ctx, "systemctl restart docker", 2*time.Minute, stream)
		}
	}
	return nil
}

// ManualRule - правило панели, применяется через ufw с комментарием panel:<id>.
type ManualRule struct {
	ID       string `json:"id"`
	PortFrom int    `json:"portFrom"`
	PortTo   int    `json:"portTo"`
	Proto    string `json:"proto"`
	Source   string `json:"source"`
	Action   string `json:"action"`
}

var ruleIDRe = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

// args - правило ufw аргументами, без оболочки: источник и id проверены и ничего не "допишут"
// (строкой в bash "1.2.3.4; reboot" выполнился бы от root).
func (r ManualRule) args() ([]string, error) {
	if !ruleIDRe.MatchString(r.ID) {
		return nil, fmt.Errorf("неверный id правила: %q", r.ID)
	}
	if r.PortFrom < 1 || r.PortFrom > 65535 || r.PortTo > 65535 {
		return nil, fmt.Errorf("неверный порт в правиле %s", r.ID)
	}
	src := "any"
	if r.Source != "" && r.Source != "any" {
		if _, err := netip.ParsePrefix(r.Source); err != nil {
			if _, err := netip.ParseAddr(r.Source); err != nil {
				return nil, fmt.Errorf("неверный источник в правиле %s: %q", r.ID, r.Source)
			}
		}
		src = r.Source
	}
	port := strconv.Itoa(r.PortFrom)
	if r.PortTo > r.PortFrom {
		port = fmt.Sprintf("%d:%d", r.PortFrom, r.PortTo)
	}
	act := "allow"
	if r.Action == "deny" {
		act = "deny"
	}
	a := []string{act, "from", src, "to", "any", "port", port}
	if r.Proto == "tcp" || r.Proto == "udp" {
		a = append(a, "proto", r.Proto)
	}
	return append(a, "comment", "panel:"+r.ID), nil
}

// SetManualRules приводит правила panel:* в ufw к списку rules.
func SetManualRules(ctx context.Context, rules []ManualRule) error {
	if !shell.Has("ufw") {
		return errors.New("ufw не установлен")
	}
	want := map[string][]string{}
	for _, r := range rules {
		a, err := r.args()
		if err != nil {
			return err
		}
		want[r.ID] = a
	}
	unlock := lockPortsync()
	defer unlock()
	present := map[string]bool{}
	// удалить лишние по номерам (с конца, чтобы номера не сдвигались)
	out := shell.Out(ctx, "ufw", "status", "numbered")
	var toDelete []int
	for _, line := range strings.Split(out, "\n") {
		if !strings.HasPrefix(strings.TrimSpace(line), "[") || !strings.Contains(line, "panel:") {
			continue
		}
		n, err := strconv.Atoi(strings.TrimSpace(line[strings.Index(line, "[")+1 : strings.Index(line, "]")]))
		if err != nil {
			continue
		}
		f := strings.Fields(line[strings.Index(line, "panel:")+6:])
		if len(f) == 0 {
			continue
		}
		if _, ok := want[f[0]]; ok {
			present[f[0]] = true
		} else {
			toDelete = append(toDelete, n)
		}
	}
	for i := len(toDelete) - 1; i >= 0; i-- {
		_ = shell.OK(ctx, "ufw", "--force", "delete", strconv.Itoa(toDelete[i]))
	}
	for id, a := range want {
		if present[id] {
			continue
		}
		res, err := shell.Exec(ctx, time.Minute, nil, "ufw", a...)
		if err != nil || res.ExitCode != 0 {
			return fmt.Errorf("ufw %s: %s", strings.Join(a, " "), strings.TrimSpace(res.Stderr+res.Stdout))
		}
	}
	return nil
}
