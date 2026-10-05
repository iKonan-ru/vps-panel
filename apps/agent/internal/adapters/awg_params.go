package adapters

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Параметры протокола, которые меняет instance.setparams; остальное в [Interface] (PrivateKey,
// Address, ListenPort, заметки) и все пиры остаются как есть.
var awgProtoKeys = []string{"Jc", "Jmin", "Jmax", "S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4",
	"I1", "I2", "I3", "I4", "I5", "J1", "J2", "J3", "Itime", "HeaderProtectionKey",
	"ContentPaddingAddition", "RekeyAfterTime", "RekeyTimeout", "RejectAfterTime",
	"KeepaliveTimeout", "MaxHandshakeAttempts", "RandomTrailers", "DisableCookies"}

// длина (до 2000 для I1-I5) проверяется отдельно: повтор в regexp Go - не больше 1000
var reAwgValue = regexp.MustCompile(`^[0-9A-Za-z+/=<> x_.-]+$`)

// replaceInterfaceParams убирает из [Interface] все параметры протокола (и закомментированные
// I1-I5) и дописывает новые перед первым [Peer]; I1-I5 - комментариями, как у приложения.
func replaceInterfaceParams(conf string, params map[string]string) string {
	proto := map[string]bool{}
	for _, k := range awgProtoKeys {
		proto[k] = true
	}
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
		k, _, ok := strings.Cut(strings.TrimSpace(strings.TrimLeft(t, "#")), "=")
		if ok && proto[strings.TrimSpace(k)] {
			continue
		}
		head = append(head, l)
	}
	for len(head) > 0 && strings.TrimSpace(head[len(head)-1]) == "" {
		head = head[:len(head)-1]
	}
	var special []string
	for _, k := range awgProtoKeys {
		v, ok := params[k]
		if !ok || v == "" {
			continue
		}
		if reIParam.MatchString(k) {
			special = append(special, "# "+k+" = "+v)
		} else {
			head = append(head, k+" = "+v)
		}
	}
	head = append(head, special...)
	out := strings.Join(head, "\n") + "\n"
	if len(rest) > 0 {
		out += "\n" + strings.Join(rest, "\n") + "\n"
	}
	return out
}

// awgRestart перезапускает интерфейс с тем же выбором реализации, что у start.sh: при модуле
// ядра старше 3.x - amneziawg-go (AWG_USERSPACE понимает awg-quick из образа панели).
func awgRestart(ctx context.Context, container, confPath string) (string, bool) {
	quick := awgTool(ctx, container) + "-quick"
	return dexec(ctx, container, "bash", "-c",
		`MOD=$(cat /sys/module/amneziawg/version 2>/dev/null); if [ -n "$MOD" ] && [ "${MOD%%.*}" -lt 3 ]; then export AWG_USERSPACE=1; fi; "$1" down "$2" >/dev/null 2>&1; "$1" up "$2"`,
		"_", quick, confPath)
}

// awgSetParams - смена версии или перевыпуск параметров экземпляра: новые параметры - в
// args ("p.<Ключ>"), проверены панелью; здесь - белый список ключей и символов.
func awgSetParams(ctx context.Context, req AwgRequest) (map[string]any, error) {
	params := map[string]string{}
	allowed := map[string]bool{}
	for _, k := range awgProtoKeys {
		allowed[k] = true
	}
	for k, v := range req.Args {
		name, ok := strings.CutPrefix(k, "p.")
		if !ok {
			continue
		}
		if !allowed[name] || len(v) > 2000 || !reAwgValue.MatchString(v) {
			return nil, errors.New("недопустимый параметр " + name)
		}
		params[name] = v
	}
	if len(params) == 0 {
		return nil, errors.New("нет параметров")
	}
	defer awgLock(req.Container)()
	c := req.Container
	confPath, conf := readAwgConf(ctx, c)
	if confPath == "" {
		return nil, errors.New("не найден конфиг AWG в контейнере " + c)
	}
	newConf := replaceInterfaceParams(conf, params)
	if err := awgBackup(ctx, c, confPath); err != nil {
		return nil, err
	}
	if err := awgWrite(ctx, c, confPath, newConf, "600"); err != nil {
		return nil, err
	}
	if msg, ok := awgRestart(ctx, c, confPath); !ok {
		// не поднялся с новыми параметрами - возвращаем прежние, чтобы клиенты не остались без VPN
		_ = awgWrite(ctx, c, confPath, conf, "600")
		_, back := awgRestart(ctx, c, confPath)
		return nil, fmt.Errorf("интерфейс не поднялся с новыми параметрами (возвращены прежние, поднят: %v): %s", back, firstLine(msg))
	}
	params2, _ := parseAwgConf(newConf)
	return map[string]any{"ok": true, "version": awgVersion(params2)}, nil
}
