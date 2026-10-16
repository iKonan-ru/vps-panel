package baseline

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/iKonan-ru/vps-panel/apps/agent/internal/shell"
)

// AddRootKeys дописывает публичные ключи в /root/.ssh/authorized_keys,
// пропуская уже существующие. Возвращает число добавленных.
func AddRootKeys(keys []string) (int, error) {
	if err := os.MkdirAll("/root/.ssh", 0o700); err != nil {
		return 0, err
	}
	return addKeys(RootKeysPath, keys)
}

// addKeys - тем же разбором, что список и удаление ключей (sshkeys.go): base64 проверяется,
// перевод строки внутри ключа отклоняется (дал бы две битые строки), дубли узнаются по
// отпечатку и с опциями, запись атомарная с копией .vps-panel.bak.
func addKeys(path string, keys []string) (int, error) {
	lines, err := readKeyLines(path)
	if err != nil {
		return 0, err
	}
	if len(lines) == 1 && lines[0] == "" {
		lines = nil
	}
	have := map[string]bool{}
	for _, l := range lines {
		if k, ok := parseKeyLine(l); ok {
			have[k.fp] = true
		}
	}
	var add []string
	for _, raw := range keys {
		s := strings.TrimSpace(raw)
		if strings.ContainsAny(s, "\r\n") {
			return 0, fmt.Errorf("в ключе перевод строки: %q", truncate(s, 40))
		}
		k, ok := parseKeyLine(s)
		if !ok {
			return 0, fmt.Errorf("не похоже на публичный ключ OpenSSH: %q", truncate(s, 40))
		}
		if have[k.fp] {
			continue
		}
		have[k.fp] = true
		add = append(add, k.String())
	}
	if len(add) == 0 {
		return 0, nil
	}
	return len(add), writeKeyLines(path, append(lines, add...))
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}

// heldPackages - пакеты на удержании (apt-mark showhold).
func heldPackages(ctx context.Context) map[string]bool {
	held := map[string]bool{}
	for _, p := range strings.Fields(shell.Out(ctx, "apt-mark", "showhold")) {
		held[p] = true
	}
	return held
}

// installedPackages - установленные из names (dpkg-query; неизвестные имена пропускаются).
func installedPackages(ctx context.Context, names []string) []string {
	res, _ := shell.Exec(ctx, time.Minute, nil, "dpkg-query", append([]string{"-W", "-f=${Package}\t${Status}\n"}, names...)...)
	return parseInstalled(res.Stdout)
}

func parseInstalled(out string) []string {
	var pkgs []string
	for _, line := range strings.Split(out, "\n") {
		name, status, ok := strings.Cut(line, "\t")
		if ok && strings.HasSuffix(strings.TrimSpace(status), " installed") {
			pkgs = append(pkgs, name)
		}
	}
	return pkgs
}

// aptWait - префикс команд apt: пока apt занят другим процессом, ждать до 10 минут. Сразу после
// включения автообновлений systemd запускает их службу apt-daily, и dpkg/apt-get падали на
// блокировке ("dpkg frontend lock was locked by another process"). Шаблоны pgrep - с [x]: иначе
// совпадут с командной строкой самой команды (sh -c).
const aptWait = `i=0; while pgrep -x apt-get >/dev/null || pgrep -x apt >/dev/null || pgrep -x dpkg >/dev/null || ` +
	`pgrep -f '[u]nattended-upgrade --' >/dev/null || pgrep -f '/usr/bin/[u]nattended-upgrade$' >/dev/null || ` +
	`pgrep -f '[a]pt.systemd.daily' >/dev/null; do ` +
	`[ $i -eq 0 ] && echo "apt занят другим процессом (обычно автообновления) - жду, до 10 минут"; ` +
	`i=$((i+1)); [ $i -gt 120 ] && { echo "apt так и не освободился за 10 минут" >&2; exit 1; }; sleep 5; done; `

// aptLock - apt-get сам ждёт блокировку dpkg (гонка с запуском автообновлений после aptWait).
const aptLock = "-o DPkg::Lock::Timeout=300 "

// Upgrade ставит обновления пакетов. Пакеты docker и ядро НЕ трогаются:
// обновление docker перезапускает демон и рвёт VPN-контейнеры, ядро требует
// перезагрузки - это делается отдельно и осознанно.
func Upgrade(ctx context.Context, stream func(channel, chunk string)) error {
	log := func(f string, a ...any) { stream("log", fmt.Sprintf(f, a...)+"\n") }
	if !shell.Has("apt-get") {
		return errors.New("apt-get не найден: поддерживаются только Debian и Ubuntu")
	}
	hold := "docker-ce docker-ce-cli docker-ce-rootless-extras docker-compose-plugin docker-buildx-plugin containerd.io docker.io containerd linux-image-generic linux-headers-generic linux-generic"
	log("== Пакеты docker и ядро на удержании (обновляются отдельно): %s", hold)
	// удержание, поставленное раньше (админом), после обновления не снимаем: только своё
	held := heldPackages(ctx)
	var ours []string
	for _, p := range installedPackages(ctx, strings.Fields(hold)) {
		if !held[p] {
			ours = append(ours, p)
		}
	}
	if len(ours) > 0 {
		// Без удержания apt обновил бы docker, а это перезапуск демона и обрыв VPN в контейнерах.
		// apt-mark ждёт ту же блокировку dpkg, что и apt; итог проверяется по apt-mark showhold.
		res, _ := shell.Run(ctx, aptWait+"apt-mark hold "+strings.Join(ours, " "), 15*time.Minute, stream)
		defer func() {
			res, err := shell.Exec(context.Background(), time.Minute, nil, "apt-mark", append([]string{"unhold"}, ours...)...)
			if err != nil || res.ExitCode != 0 {
				log("ВНИМАНИЕ: не удалось снять удержание пакетов (apt-mark unhold %s): %s", strings.Join(ours, " "), strings.TrimSpace(res.Stderr+res.Stdout))
			}
		}()
		now := heldPackages(ctx)
		for _, p := range ours {
			if !now[p] {
				return fmt.Errorf("не удалось удержать пакет %s (apt-mark hold), обновление не начато: %s", p, strings.TrimSpace(res.Stderr+res.Stdout))
			}
		}
	}
	cmd := aptWait + "dpkg --configure -a && apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get " + aptLock +
		"upgrade -y -qq -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold && apt-get " + aptLock +
		"autoremove -y -qq"
	before := wanState(ctx)
	log("== apt-get upgrade")
	res, err := shell.Run(ctx, cmd, 30*time.Minute, stream)
	// и после сбоя apt: сеть могла пропасть на любом пакете, а без сети агент не вернётся в панель
	ensureNetwork(before, log)
	if err != nil {
		return err
	}
	if res.ExitCode != 0 {
		return fmt.Errorf("apt-get завершился с кодом %d", res.ExitCode)
	}
	if _, err := os.Stat("/var/run/reboot-required"); err == nil {
		log("== Готово. Требуется перезагрузка (обновлено ядро или libc): \"Перезагрузить сервер\" в меню сервера")
	} else {
		log("== Готово")
	}
	return nil
}
