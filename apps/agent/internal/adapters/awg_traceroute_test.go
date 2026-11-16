package adapters

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

const traceConf = `[Interface]
PrivateKey = cHJpdmF0ZQ==
Address = 10.8.1.0/24
ListenPort = 51820
Jc = 4
PostUp = echo user-hook
# I1 = <b 0x01>

[Peer]
PublicKey = AAAA
AllowedIPs = 10.8.1.2/32
`

func TestTraceHooksAddRemove(t *testing.T) {
	on := setAwgTraceHooks(traceConf, true)
	if !awgTraceConfigured(on) {
		t.Fatalf("хуки не записаны:\n%s", on)
	}
	// чужой хук, комментарий I1 и пиры - на месте; хуки - в [Interface], до [Peer]
	for _, want := range []string{"PostUp = echo user-hook", "# I1 = <b 0x01>", "[Peer]\nPublicKey = AAAA"} {
		if !strings.Contains(on, want) {
			t.Fatalf("пропало %q:\n%s", want, on)
		}
	}
	if strings.Index(on, awgTraceComment) > strings.Index(on, "[Peer]") {
		t.Fatalf("хуки не в [Interface]:\n%s", on)
	}
	// повторное включение - без дубликатов
	if again := setAwgTraceHooks(on, true); again != on {
		t.Fatalf("повтор изменил конфиг:\n%s", again)
	}
	off := setAwgTraceHooks(on, false)
	if awgTraceConfigured(off) || strings.Contains(off, awgTraceComment) {
		t.Fatalf("хуки не убраны:\n%s", off)
	}
	if off != setAwgTraceHooks(traceConf, false) || !strings.Contains(off, "echo user-hook") {
		t.Fatalf("выключение тронуло чужое:\n%s", off)
	}
}

func TestTraceHooksSurviveParamsChange(t *testing.T) {
	on := setAwgTraceHooks(traceConf, true)
	changed := replaceInterfaceParams(on, map[string]string{"Jc": "7"})
	if !awgTraceConfigured(changed) || !strings.Contains(changed, "Jc = 7") {
		t.Fatalf("смена параметров потеряла хуки:\n%s", changed)
	}
	// свои хуки в старом формате (SaveConfig) - тоже свои: убираются и заменяются точными
	up, _ := awgTraceHooks()
	odd := strings.Replace(on, up, strings.Replace(up, "PostUp = ", "PostUp=", 1), 1)
	if awgTraceConfigured(odd) {
		t.Fatal("неточный хук принят за настройку")
	}
	if fixed := setAwgTraceHooks(odd, true); !awgTraceConfigured(fixed) || strings.Count(fixed, "PostUp") != 2 || strings.Contains(fixed, "PostUp=") {
		t.Fatalf("неточный хук не заменён:\n%s", fixed)
	}
}

func TestTraceParamsHidden(t *testing.T) {
	params, _ := parseAwgConf(setAwgTraceHooks(traceConf, true))
	own := 0
	for _, p := range params {
		if strings.Contains(p.Value, awgTraceComment) {
			own++
		}
	}
	if own != 2 {
		t.Fatalf("parseAwgConf: своих хуков %d", own)
	}
}

func TestTraceRules(t *testing.T) {
	ours := `-A OUTPUT -o awg0 -p icmp -m icmp --icmp-type 11/0 -m comment --comment ` + awgTraceComment + ` -j DROP`
	accept := `-A OUTPUT -o awg0 -j ACCEPT`
	cases := []struct {
		name           string
		text           string
		own            int
		before, manual bool
	}{
		{"нет", "-P OUTPUT ACCEPT\n" + accept, 0, false, false},
		{"первым", "-P OUTPUT ACCEPT\n" + ours + "\n" + accept, 1, true, false},
		{"после ACCEPT", "-P OUTPUT ACCEPT\n" + accept + "\n" + ours, 1, false, false},
		{"в кавычках (nft)", strings.Replace(ours, awgTraceComment, `"`+awgTraceComment+`"`, 1) + "\n" + accept, 1, true, false},
		{"дубликаты", ours + "\n" + ours + "\n" + accept, 2, true, false},
		{"ручное", "-A OUTPUT -o awg0 -p icmp -m icmp --icmp-type 11/0 -j DROP\n" + accept, 0, false, true},
		{"другой интерфейс", strings.Replace(ours, "awg0", "wg0", 1), 0, false, false},
		{"другой тип ICMP", strings.Replace(ours, "11/0", "3/4", 1), 0, false, false},
	}
	for _, c := range cases {
		own, before, manual := awgTraceRules(c.text, "awg0")
		if own != c.own || before != c.before || manual != c.manual {
			t.Errorf("%s: own=%d before=%v manual=%v", c.name, own, before, manual)
		}
	}
}

// Упавший iptables в PostUp не срывает запуск: awg-quick выполняет хуки под set -e.
func TestTraceHookNeverFails(t *testing.T) {
	bash, err := exec.LookPath("bash")
	if err != nil {
		t.Skip("нет bash")
	}
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "iptables"), []byte("#!/bin/sh\nexit 1\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	up, down := awgTraceHooks()
	for _, line := range []string{up, down} {
		hook := strings.ReplaceAll(strings.TrimSpace(strings.SplitN(line, "=", 2)[1]), "%i", "awg0")
		cmd := exec.Command(bash, "-c", `set -e -o pipefail; (eval "$HOOK"); echo after`)
		cmd.Env = []string{"PATH=" + dir + ":/usr/bin:/bin", "HOOK=" + hook}
		out, err := cmd.CombinedOutput()
		if err != nil || !strings.Contains(string(out), "after") {
			t.Fatalf("хук сорвал запуск: %v\n%s", err, out)
		}
		if line == up && !strings.Contains(string(out), "не применено") {
			t.Fatalf("PostUp не сообщил об ошибке:\n%s", out)
		}
	}
}
