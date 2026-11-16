package adapters

import (
	"context"
	"errors"
	"fmt"
	"path"
	"regexp"
	"strings"
	"time"
)

// Скрытие узла AWG в трассировке IPv4: внутри контейнера экземпляра правило iptables не даёт
// отправлять в туннель ICMP Time Exceeded (11/0) - вместо этого узла в трассировке звёздочки.
// Правило - с меткой панели, первым в OUTPUT (до разрешающего "-o awg0 -j ACCEPT" из start.sh).
// После перезапуска его ставят PostUp/PostDown в конфиге экземпляра (awg-quick).

// awgTraceComment - метка своего правила: выключение удаляет только правила с ней.
const awgTraceComment = "vps-panel:awg-traceroute-v1"

var reAwgIface = regexp.MustCompile(`^(awg0|wg0)$`)

// AwgTraceroute - состояние настройки экземпляра.
type AwgTraceroute struct {
	// Configured - в конфиге сохранены хуки панели.
	Configured bool `json:"configured"`
	// Applied - своё правило стоит до разрешающего правила интерфейса; nil - проверить нельзя.
	Applied *bool `json:"applied"`
	// Manual - такое же правило без метки панели: им панель не управляет.
	Manual bool   `json:"manual,omitempty"`
	Error  string `json:"error,omitempty"`
}

// awgTraceSpec - правило без цепочки; iface - проверенное имя или %i в хуке.
func awgTraceSpec(iface string) string {
	return "-o " + iface + " -p icmp --icmp-type 11/0 -m comment --comment " + awgTraceComment + " -j DROP"
}

// awgTraceHooks - строки хуков панели. Ошибка PostUp не срывает запуск VPN (awg-quick
// работает под set -e): хук только сообщает о ней.
func awgTraceHooks() (up, down string) {
	spec := awgTraceSpec("%i")
	up = "PostUp = iptables -w 5 -C OUTPUT " + spec + " 2>/dev/null || iptables -w 5 -I OUTPUT 1 " + spec +
		" || echo 'vps-panel: правило скрытия в трассировке не применено' >&2"
	down = "PostDown = while iptables -w 5 -D OUTPUT " + spec + " 2>/dev/null; do :; done"
	return up, down
}

// isOwnHook - строка [Interface] - хук панели (по метке; формат мог поменять SaveConfig).
func isOwnHook(line string) bool {
	k, v, ok := strings.Cut(strings.TrimSpace(line), "=")
	if !ok {
		return false
	}
	k = strings.TrimSpace(k)
	return (strings.EqualFold(k, "PostUp") || strings.EqualFold(k, "PostDown")) && strings.Contains(v, awgTraceComment)
}

// awgTraceConfigured - в [Interface] есть оба хука панели в точности.
func awgTraceConfigured(conf string) bool {
	up, down := awgTraceHooks()
	hasUp, hasDown := false, false
	section := ""
	for _, l := range strings.Split(conf, "\n") {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "[") {
			section = strings.ToLower(strings.Trim(t, "[] "))
			continue
		}
		if section != "interface" {
			continue
		}
		hasUp = hasUp || t == up
		hasDown = hasDown || t == down
	}
	return hasUp && hasDown
}

// setAwgTraceHooks убирает хуки панели из [Interface] и, если on, дописывает их в конец секции;
// остальные строки (чужие хуки, пиры) - как были.
func setAwgTraceHooks(conf string, on bool) string {
	lines := strings.Split(strings.TrimRight(conf, "\n"), "\n")
	var head, rest []string
	section := ""
	for i, l := range lines {
		t := strings.TrimSpace(l)
		if strings.HasPrefix(t, "[") {
			section = strings.ToLower(strings.Trim(t, "[] "))
			if section != "interface" {
				rest = lines[i:]
				break
			}
			head = append(head, l)
			continue
		}
		if section == "interface" && isOwnHook(l) {
			continue
		}
		head = append(head, l)
	}
	for len(head) > 0 && strings.TrimSpace(head[len(head)-1]) == "" {
		head = head[:len(head)-1]
	}
	if on {
		up, down := awgTraceHooks()
		head = append(head, up, down)
	}
	out := strings.Join(head, "\n") + "\n"
	if len(rest) > 0 {
		out += "\n" + strings.Join(rest, "\n") + "\n"
	}
	return out
}

// awgTraceRules - разбор "iptables -S OUTPUT": сколько своих правил интерфейса, стоит ли первое
// из них до разрешающего правила интерфейса, есть ли такое же без метки.
func awgTraceRules(text, iface string) (own int, before, manual bool) {
	firstOwn, firstAccept := -1, -1
	for i, l := range strings.Split(text, "\n") {
		f := strings.Fields(strings.ReplaceAll(l, `"`, ""))
		if len(f) < 2 || f[0] != "-A" || f[1] != "OUTPUT" || !hasPair(f, "-o", iface) {
			continue
		}
		drop11 := hasPair(f, "-j", "DROP") && hasPair(f, "--icmp-type", "11/0") && hasPair(f, "-p", "icmp")
		switch {
		case drop11 && hasPair(f, "--comment", awgTraceComment):
			own++
			if firstOwn < 0 {
				firstOwn = i
			}
		case drop11:
			manual = true
		case hasPair(f, "-j", "ACCEPT") && firstAccept < 0:
			firstAccept = i
		}
	}
	before = firstOwn >= 0 && (firstAccept < 0 || firstOwn < firstAccept)
	return own, before, manual
}

func hasPair(f []string, k, v string) bool {
	for i := 0; i+1 < len(f); i++ {
		if f[i] == k && f[i+1] == v {
			return true
		}
	}
	return false
}

// awgIptables - iptables внутри контейнера экземпляра.
func awgIptables(ctx context.Context, container string, args ...string) (string, bool) {
	res, err := awgDocker(ctx, 20*time.Second, nil, append([]string{"exec", container, "iptables", "-w", "5"}, args...)...)
	if err != nil || res.ExitCode != 0 {
		return strings.TrimSpace(res.Stderr + res.Stdout), false
	}
	return res.Stdout, true
}

// awgTraceState - состояние экземпляра: хуки в конфиге и действующее правило.
func awgTraceState(ctx context.Context, container, iface, conf string) AwgTraceroute {
	st := AwgTraceroute{Configured: awgTraceConfigured(conf)}
	text, ok := awgIptables(ctx, container, "-S", "OUTPUT")
	if !ok {
		st.Error = "iptables не ответил: " + firstLine(text)
		return st
	}
	own, before, manual := awgTraceRules(text, iface)
	applied := own > 0 && before
	st.Applied, st.Manual = &applied, manual
	if st.Configured && !applied {
		st.Error = "настройка сохранена, правило не применено"
	} else if !st.Configured && own > 0 {
		st.Error = "правило панели действует, но в конфиге настройки нет"
	}
	return st
}

// awgTraceLive ставит своё правило первым (без дубликатов) или удаляет все свои.
func awgTraceLive(ctx context.Context, container, iface string, on bool) error {
	spec := strings.Fields(awgTraceSpec(iface))
	// свои правила - все разом: дубликаты и правило не на своём месте убираются
	for i := 0; i < 20; i++ {
		if _, ok := awgIptables(ctx, container, append([]string{"-D", "OUTPUT"}, spec...)...); !ok {
			break
		}
	}
	if !on {
		return nil
	}
	if msg, ok := awgIptables(ctx, container, append([]string{"-I", "OUTPUT", "1"}, spec...)...); !ok {
		return errors.New("iptables: " + firstLine(msg))
	}
	return nil
}

// AwgTracerouteSet включает или выключает скрытие узла в трассировке у экземпляра: хуки в
// конфиге и правило на работающем интерфейсе, без перезапуска. Не сошлось с ожидаемым -
// откат своих изменений, итог отката - в ошибке.
func AwgTracerouteSet(ctx context.Context, container string, on bool) (AwgTraceroute, error) {
	if !reAwgContainer.MatchString(container) {
		return AwgTraceroute{}, errors.New("неверное имя контейнера")
	}
	defer awgLock(container)()
	confPath, conf := readAwgConf(ctx, container)
	if confPath == "" {
		return AwgTraceroute{}, errors.New("не найден конфиг AWG в контейнере " + container)
	}
	iface := strings.TrimSuffix(path.Base(confPath), ".conf")
	if !reAwgIface.MatchString(iface) {
		return AwgTraceroute{}, errors.New("неожиданный интерфейс " + iface)
	}
	text, ok := awgIptables(ctx, container, "-S", "OUTPUT")
	if !ok {
		return AwgTraceroute{}, errors.New("iptables в контейнере не ответил: " + firstLine(text))
	}
	ownBefore, _, _ := awgTraceRules(text, iface)

	newConf := setAwgTraceHooks(conf, on)
	if newConf != conf {
		if err := awgBackup(ctx, container, confPath); err != nil {
			return AwgTraceroute{}, err
		}
		if err := awgWrite(ctx, container, confPath, newConf, "600"); err != nil {
			return AwgTraceroute{}, err
		}
	}
	err := awgTraceLive(ctx, container, iface, on)
	st := awgTraceState(ctx, container, iface, newConf)
	if err == nil && (st.Configured != on || st.Applied == nil || *st.Applied != on) {
		err = errors.New("после изменения состояние не совпало с ожидаемым")
		if st.Error != "" {
			err = fmt.Errorf("%w: %s", err, st.Error)
		}
	}
	if err == nil {
		return st, nil
	}
	// откат: прежний конфиг и прежнее наличие своего правила
	var back []string
	if newConf != conf {
		if e := awgWrite(ctx, container, confPath, conf, "600"); e != nil {
			back = append(back, "конфиг не возвращён: "+e.Error())
		}
	}
	if e := awgTraceLive(ctx, container, iface, ownBefore > 0); e != nil {
		back = append(back, "правило не возвращено: "+e.Error())
	}
	_, c2 := readAwgConf(ctx, container)
	if got := awgTraceState(ctx, container, iface, c2); got.Configured != awgTraceConfigured(conf) ||
		got.Applied == nil || *got.Applied != (ownBefore > 0) {
		back = append(back, "после отката состояние другое")
	}
	if len(back) > 0 {
		return st, fmt.Errorf("%v; откат не полный: %s", err, strings.Join(back, "; "))
	}
	return st, fmt.Errorf("%v; изменения отменены", err)
}
