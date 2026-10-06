import type { CommandDef } from './types.js';
import { NAIVE_FUNCS, PROLOGUE } from './util.js';

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
    { value: 'no', label: 'нет, не удалять' },
    { value: 'yes', label: 'да, удалить' },
  ],
};
const GUARD = `[ "$CONFIRM" = "yes" ] || { echo "удаление не подтверждено" >&2; exit 2; }`;

export const xuiUninstallCmd: CommandDef = {
  id: 'xui-uninstall',
  title: 'Удалить 3X-UI',
  group: 'maintain',
  service: '3X-UI',
  description:
    'Снести панель 3X-UI вместе с Xray: служба, /usr/local/x-ui, база /etc/x-ui. Пользователи Xray перестанут подключаться.',
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
  preflight: `if [ -x /usr/local/x-ui/x-ui ]; then echo "WARN|3X-UI установлен: удалятся панель, Xray и база inbound-ов (сделай бэкап во вкладке Бэкапы)"; else echo "FAIL|3X-UI не установлен"; fi`,
  plan: () => [
    'x-ui uninstall: остановить службу, удалить /usr/local/x-ui и /etc/x-ui (база с пользователями)',
    'Убрать jail fail2ban панели; port-sync закроет порты панели и inbound-ов',
  ],
  after: 'Запись в "Доступах" и сертификат панели остаются - удали вручную, если не нужны.',
};

export const mtproxylUninstallCmd: CommandDef = {
  id: 'mtproxyl-uninstall',
  title: 'Удалить MTProxyL',
  group: 'maintain',
  service: 'MTProxyL',
  description:
    'Снести MTProxyL вместе с веб-панелью: контейнер или служба telemt, конфиги и секреты в /opt/mtproxyl, правила nft, панель с конфигом и данными.',
  params: [CONFIRM],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}${NAIVE_FUNCS}
${GUARD}
need mtproxyl || { echo "MTProxyL не установлен" >&2; exit 3; }
if systemctl list-unit-files mtproxyl-panel.service >/dev/null 2>&1 && systemctl cat mtproxyl-panel >/dev/null 2>&1; then
  say "Сначала веб-панель MTProxyL"
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
  preflight: `${NAIVE_FUNCS}if command -v mtproxyl >/dev/null 2>&1; then echo "WARN|MTProxyL установлен: пропадут секреты пользователей и ссылки (сделай бэкап во вкладке Бэкапы)"; else echo "FAIL|MTProxyL не установлен"; fi
if naive_installed && grep -q '"mask443": true' /etc/vps-naive/config.json 2>/dev/null; then echo "OK|прокси для браузера отвечает на 443 через MTProxyL: после удаления будет слушать 443 сам (служба прокси перезапустится)"; fi`,
  plan: () => [
    'Удалить веб-панель MTProxyL, если есть (с конфигом и данными)',
    'mtproxyl uninstall: остановить движок, снять правила nft, удалить /opt/mtproxyl без выгрузки секретов',
    'Прокси для браузера, если он отвечал на 443 через MTProxyL, снова слушает 443 сам',
  ],
};

export const wdttUninstallCmd: CommandDef = {
  id: 'wdtt-uninstall',
  title: 'Удалить WDTT',
  group: 'maintain',
  service: 'WDTT',
  description:
    'Снести сервер WDTT: служба, бинарник, интерфейс и правила firewall. База доступа (кто подключался) сохраняется в /etc/wdtt.',
  params: [CONFIRM],
  timeoutSec: 5 * 60,
  script: `${PROLOGUE}
${GUARD}
[ -x /usr/local/bin/wdtt-server ] || { echo "WDTT не установлен" >&2; exit 3; }
say "Скачиваю deploy.sh с панели"
fetch "$PANEL_URL/files/wdtt/deploy.sh" -o /tmp/wdtt-deploy.sh
say "Удаляю WDTT (deploy.sh uninstall)"
bash /tmp/wdtt-deploy.sh uninstall </dev/null
rm -f /tmp/wdtt-deploy.sh
say "Готово"
`,
  preflight: `if [ -x /usr/local/bin/wdtt-server ]; then echo "WARN|WDTT установлен: клиенты перестанут подключаться"; else echo "FAIL|WDTT не установлен"; fi`,
  plan: () => [
    'deploy.sh uninstall: остановить службу, удалить бинарник, интерфейс и правила',
    'Конфиг с ключами удаляется, база доступа остаётся в /etc/wdtt',
  ],
};

export const awgUninstallCmd: CommandDef = {
  id: 'awg-uninstall',
  title: 'Удалить Amnezia AWG',
  group: 'maintain',
  service: 'Amnezia AWG',
  description:
    'Остановить и удалить контейнер AmneziaWG. Все клиенты этого контейнера перестанут подключаться; данные (/opt/amnezia/awg внутри) можно сохранить бэкапом.',
  params: [
    {
      name: 'AWG_CONTAINER',
      label: 'Контейнер',
      type: 'awg-container',
      required: true,
      hint: 'экземпляры AWG, которые агент нашёл на этом сервере',
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
say "Готово: port-sync закроет порт"
`,
  preflight: `if docker inspect "$AWG_CONTAINER" >/dev/null 2>&1; then echo "WARN|контейнер $AWG_CONTAINER работает: все его клиенты потеряют VPN (сделай бэкап Amnezia во вкладке Бэкапы)"; else echo "FAIL|контейнер $AWG_CONTAINER не найден"; fi`,
  plan: (a) => [
    `docker rm -f ${a.AWG_CONTAINER}: ключи сервера и клиентов внутри контейнера пропадут`,
    `Удалить образ ${a.AWG_CONTAINER} и /opt/amnezia/${a.AWG_CONTAINER} на хосте`,
  ],
};
