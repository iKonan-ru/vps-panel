import type { CommandDef } from './types.js';
import { NAIVE_FUNCS, PROLOGUE, WDTT_FW_FUNCS } from './util.js';

/**
 * Удаление сервисов, поставленных командами каталога. Каждая команда сначала
 * показывает в плане, что именно пропадёт, и требует явного "да" в форме.
 * Подтверждения самих установщиков проходят через stdin, интерактивные меню не трогаем.
 */

const CONFIRM = {
  name: 'CONFIRM',
  label: 'Подтверждение',
  type: 'select' as const,
  default: 'no',
  required: true,
  options: [
    { value: 'no', label: 'не удалять' },
    { value: 'yes', label: 'удалить' },
  ],
};
const GUARD = `[ "$CONFIRM" = "yes" ] || { echo "удаление не подтверждено" >&2; exit 2; }`;

export const xuiUninstallCmd: CommandDef = {
  id: 'xui-uninstall',
  title: 'Удалить 3X-UI',
  group: 'maintain',
  service: '3X-UI',
  description: 'Удаляет 3X-UI вместе с Xray и базой. Клиенты Xray перестанут подключаться.',
  params: [CONFIRM],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}
${GUARD}
[ -x /usr/local/x-ui/x-ui ] || { echo "3X-UI не установлен" >&2; exit 3; }
say "Удаляю 3X-UI (x-ui uninstall)"
# x-ui uninstall в конце удаляет сам себя и выходит с кодом 1 даже при успехе (delete_script
# в x-ui.sh) - итог проверяем по факту
printf 'y\\n' | x-ui uninstall || true
if [ -e /usr/local/x-ui/x-ui ] || systemctl is-active --quiet x-ui 2>/dev/null; then
  echo "3X-UI не удалился: /usr/local/x-ui или служба x-ui остались" >&2
  exit 1
fi
rm -f /etc/fail2ban/jail.d/xui-panel.conf
systemctl reload fail2ban 2>/dev/null || true
say "Готово"
`,
  preflight: `if [ -x /usr/local/x-ui/x-ui ]; then echo "WARN|будут удалены панель, Xray и все inbound; резервная копия\u00a0\u2014 на вкладке \u00abРезервные копии\u00bb"; else echo "FAIL|3X-UI не установлен"; fi`,
  plan: () => ['Удалить 3X-UI с Xray и базой inbound', 'Закрыть порты панели и inbound'],
  after: 'Запись в\u00a0\u00abДоступах\u00bb и сертификат панели не удаляются.',
  dropsBindings: ['xui'],
};

export const mtproxylUninstallCmd: CommandDef = {
  id: 'mtproxyl-uninstall',
  title: 'Удалить MTProxyL',
  group: 'maintain',
  service: 'MTProxyL',
  description:
    'Удаляет MTProxyL с веб-панелью, пользователями и секретами. Ссылки tg://proxy перестанут работать.',
  params: [CONFIRM],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}${NAIVE_FUNCS}
${GUARD}
need mtproxyl || { echo "MTProxyL не установлен" >&2; exit 3; }
if systemctl list-unit-files mtproxyl-panel.service >/dev/null 2>&1 && systemctl cat mtproxyl-panel >/dev/null 2>&1; then
  say "Удаляю веб-панель MTProxyL"
  printf 'y\\n' | mtproxyl panel uninstall --no-confirm || true
fi
say "Удаляю MTProxyL (mtproxyl uninstall)"
printf 'yes\\nn\\n' | mtproxyl uninstall
# прокси для браузера отвечал на 443 через маску telemt: 443 освободился - слушает его сам
if naive_installed && [ "$(naive_mode)" = mask ]; then
  sleep 2
  if [ -z "$(port_owner 443)" ]; then
    say "Прокси для браузера: 443 свободен - Caddy снова слушает его сам"
    naive_443 listen
  else
    say "Прокси для браузера: 443 занят ($(port_owner 443)) - прокси только на своём порту"
    naive_443 none
  fi
  [ -x /usr/local/sbin/vps-portsync ] && /usr/local/sbin/vps-portsync | tail -n 5 || true
fi
say "Готово"
`,
  preflight: `${NAIVE_FUNCS}if command -v mtproxyl >/dev/null 2>&1; then echo "WARN|секреты и ссылки пользователей будут удалены; резервная копия\u00a0\u2014 на вкладке \u00abРезервные копии\u00bb"; else echo "FAIL|MTProxyL не установлен"; fi
if naive_installed && grep -q '"mask443": true' /etc/vps-naive/config.json 2>/dev/null; then echo "OK|прокси для браузера займёт порт 443 сам и перезапустится"; fi`,
  plan: () => [
    'Удалить веб-панель MTProxyL',
    'Удалить MTProxyL с пользователями и секретами',
    'Вернуть порт 443 прокси для браузера, если он отвечал через MTProxyL',
  ],
  dropsBindings: ['mtproxyl'],
};

export const wdttUninstallCmd: CommandDef = {
  id: 'wdtt-uninstall',
  title: 'Удалить WDTT',
  group: 'maintain',
  service: 'WDTT',
  description:
    'Удаляет сервер WDTT, клиенты перестанут подключаться. База доступа остаётся на сервере.',
  params: [CONFIRM],
  timeoutSec: 5 * 60,
  script: `${PROLOGUE}
${GUARD}
[ -x /usr/local/bin/wdtt-server ] || { echo "WDTT не установлен" >&2; exit 3; }
# порты WDTT до удаления (ss -tu -H: Netid, State, Recv-Q, Send-Q, Local - 5-я колонка)
ports="$(ss -lntupH 2>/dev/null | awk '/wdtt-server/ {n=split($5,a,":"); print a[n]}' | sort -u | tr '\n' ' ')"
say "Скачиваю deploy.sh с панели"
fetch "$PANEL_URL/files/wdtt/deploy.sh" -o /tmp/wdtt-deploy.sh
say "Удаляю WDTT (deploy.sh uninstall)"
bash /tmp/wdtt-deploy.sh uninstall </dev/null
rm -f /tmp/wdtt-deploy.sh
${WDTT_FW_FUNCS}
if portsync_governs; then
  say "Убираю зеркальные правила iptables WDTT (порты ведёт port-sync)"
  wdtt_mirrors_drop
  timeout 120 /usr/local/sbin/vps-portsync >/dev/null 2>&1 || true
elif [ -n "$ports" ]; then
  say "Убираю правила iptables WDTT_MIRRORED для портов WDTT: $ports"
  wdtt_mirrors_drop $ports
fi
say "Готово"
`,
  preflight: `if [ -x /usr/local/bin/wdtt-server ]; then echo "WARN|WDTT установлен: клиенты перестанут подключаться"; else echo "FAIL|WDTT не установлен"; fi`,
  plan: () => [
    'Удалить WDTT с ключами',
    'Убрать правила firewall WDTT',
    'Оставить базу доступа на сервере',
  ],
  dropsBindings: ['wdtt'],
};

export const awgUninstallCmd: CommandDef = {
  id: 'awg-uninstall',
  title: 'Удалить Amnezia AWG',
  group: 'maintain',
  service: 'Amnezia AWG',
  description: 'Удаляет контейнер AmneziaWG вместе с ключами. Его клиенты перестанут подключаться.',
  params: [
    {
      name: 'AWG_CONTAINER',
      label: 'Контейнер',
      type: 'awg-container',
      required: true,
    },
    CONFIRM,
  ],
  timeoutSec: 5 * 60,
  script: `${PROLOGUE}
${GUARD}
need docker || { echo "docker не установлен" >&2; exit 3; }
docker inspect "$AWG_CONTAINER" >/dev/null 2>&1 || { echo "контейнер $AWG_CONTAINER не найден" >&2; exit 3; }
say "Удаляю контейнер $AWG_CONTAINER"
docker rm -f "$AWG_CONTAINER"
docker image rm "$AWG_CONTAINER" 2>/dev/null || true
rm -rf "/opt/amnezia/$AWG_CONTAINER"
say "Готово: порт закроется автоматически"
`,
  preflight: `if docker inspect "$AWG_CONTAINER" >/dev/null 2>&1; then echo "WARN|клиенты $AWG_CONTAINER потеряют доступ; резервная копия\u00a0\u2014 на вкладке \u00abРезервные копии\u00bb"; else echo "FAIL|контейнер $AWG_CONTAINER не найден"; fi`,
  plan: (a) => [
    `Удалить контейнер ${a.AWG_CONTAINER} с ключами сервера и клиентов`,
    'Удалить образ контейнера',
  ],
  dropsBindings: ['awg'],
  dropsBindingsRef: (a) => `|${a.AWG_CONTAINER ?? ''}|`,
};
