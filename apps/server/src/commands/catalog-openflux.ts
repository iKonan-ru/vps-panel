import type { CommandDef } from './types.js';
import { PROLOGUE } from './util.js';

/**
 * OpenFlux: установщик node-install.sh из репозитория
 * p1neappleXpress/OpenFlux по закреплённому коммиту со сверкой sha256 - тот же, что качает агент
 * (apps/agent/internal/adapters/openflux.go: ofInstallerURL, ofInstallerSHA256). Установщик ставит
 * ядро только вместе с каналом, поэтому установка - это первый канал; остальные каналы и каналы
 * клиентов панели заводятся во вкладке OpenFlux и сверкой.
 */
const INSTALLER_URL =
  'https://raw.githubusercontent.com/p1neappleXpress/OpenFlux/ba31d0fc38b9b227231056a5ef845f7eae08f42c/deploy/node-install.sh';
const INSTALLER_SHA256 = '90fd4532ac960fa2c508d55f978baf64871f15128a9531f71144e6f063d9c858';
const INSTALLED = '/opt/openflux-node/node-install.sh';

/** Скачать установщик в $OF_INST и сверить sha256. */
const FETCH_INSTALLER = `OF_INST=$(mktemp /root/node-install-XXXXXX.sh)
trap 'rm -f "$OF_INST"' EXIT
fetch "${INSTALLER_URL}" -o "$OF_INST"
echo "${INSTALLER_SHA256}  $OF_INST" | sha256sum -c --quiet - || { echo "sha256 установщика не совпал - файл подменён или версия сменилась" >&2; exit 3; }
`;

/** Комнаты cups.online: как агент (ofRooms) - страница без cookies, uuid из data-room, base64url(JSON). */
const CUPS_ROOMS = `of_cups_rooms() {
  local ids="" id i a
  for i in 1 2 3 4; do
    for a in 1 2 3; do
      id=$(curl -fsS --max-time 30 -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36" \\
        -H 'Accept-Language: ru-RU,ru;q=0.9' https://interview.cups.online/live-coding/ 2>/dev/null \\
        | grep -oE 'data-room="\\{&quot;uuid&quot;: *&quot;[0-9a-f-]{36}' | grep -oE '[0-9a-f-]{36}$' | head -n 1 || true)
      [ -n "$id" ] && break
      sleep $((a * 2))
    done
    [ -n "$id" ] && ids="\${ids:+$ids,}\\"$id\\""
    sleep 1
  done
  [ -n "$ids" ] || return 0
  printf '[%s]' "$ids" | base64 -w0 | tr '+/' '-_' | tr -d '='
}
`;

export const openfluxCmd: CommandDef = {
  id: 'openflux',
  title: 'OpenFlux',
  group: 'install',
  service: 'OpenFlux',
  description:
    'Нода OpenFlux (выход для приложения OpenFlux) установщиком проекта: ядро с GitHub со сверкой SHA-256, служба openflux-node@<канал> и первый канал. Канал работает напрямую по TCP и, по желанию, через комнаты cups.online и документы Яндекса и Mail.ru.',
  params: [
    {
      name: 'OF_CHANNEL',
      label: 'Имя первого канала',
      type: 'string',
      default: 'main',
      required: true,
      pattern: '^[a-z0-9][a-z0-9-]{0,30}$',
      hint: 'a-z, 0-9 и дефис; каналы клиентов панели (vp-...) панель заведёт сама',
    },
    {
      name: 'OF_CUPS',
      label: 'Комнаты cups.online',
      type: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: 'создать (запасной транспорт)' },
        { value: 'no', label: 'без них' },
      ],
    },
    {
      name: 'OF_VYANDEX',
      label: 'Яндекс Документ',
      type: 'string',
      secret: true,
      pattern: '^https://(docs|disk)\\.yandex\\.(ru|com|by|kz|uz)/edit/d/[A-Za-z0-9_-]{16,200}$',
      hint: 'необязательно: https://docs.yandex.ru/edit/d/... с редактированием по ссылке',
    },
    {
      name: 'OF_MAILRU',
      label: 'Документ Mail.ru',
      type: 'string',
      secret: true,
      pattern: '^https://cloud\\.mail\\.ru/public/[A-Za-z0-9_-]{2,64}/[A-Za-z0-9_-]{2,128}$',
      hint: 'необязательно: https://cloud.mail.ru/public/... с редактированием по ссылке',
    },
    {
      name: 'OF_AUTOUPDATE',
      label: 'Автообновление ядра',
      type: 'select',
      default: 'yes',
      options: [
        { value: 'yes', label: 'включить (раз в 6 часов, с откатом)' },
        { value: 'no', label: 'выключить' },
      ],
    },
  ],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}
need curl || apt_install curl
say "Скачиваю установщик OpenFlux (закреплённый коммит, проверка sha256)"
${FETCH_INSTALLER}${CUPS_ROOMS}
OF_ROOMS=""
if [ "$OF_CUPS" = "yes" ]; then
  say "Создаю комнаты cups.online"
  OF_ROOMS=$(of_cups_rooms)
  [ -n "$OF_ROOMS" ] && echo "комнаты созданы" || echo "cups.online не отдал комнат - канал будет без них"
fi
say "План установщика"
plan=$(printf 'channel=%s\\n' "$OF_CHANNEL" | sh "$OF_INST" plan) || { echo "$plan" >&2; exit 3; }
echo "$plan"
port=$(printf '%s' "$plan" | grep -oE '"port":[0-9]+' | grep -oE '[0-9]+$' || true)
[ -n "$port" ] || { echo "установщик не дал порт" >&2; exit 3; }
say "Ставлю канал $OF_CHANNEL на порту $port"
cfg=$(mktemp /root/openflux-cfg-XXXXXX)
{
  printf 'channel=%s\\n' "$OF_CHANNEL"
  printf 'key=%s\\n' "$(od -An -tx1 -N32 /dev/urandom | tr -d ' \\n')"
  printf 'port=%s\\n' "$port"
  [ -n "$OF_VYANDEX" ] && printf 'vyandex=%s\\n' "$OF_VYANDEX"
  [ -n "$OF_MAILRU" ] && printf 'mailru=%s\\n' "$OF_MAILRU"
  [ -n "$OF_ROOMS" ] && printf 'cupsonline=%s\\n' "$OF_ROOMS"
  printf 'autoupdate=%s\\n' "$OF_AUTOUPDATE"
} > "$cfg"
# установщик читает конфигурацию из файла 0600 и сам его удаляет
apt_wait
sh "$OF_INST" apply "$cfg"
say "Каналы на сервере"
sh ${INSTALLED} list
say "Готово"
`,
  preflight: `if [ ! -d /run/systemd/system ]; then echo "FAIL|на сервере нет systemd"; fi
if [ -d "/etc/openflux-node/$OF_CHANNEL" ]; then echo "FAIL|канал $OF_CHANNEL уже есть на сервере"
elif [ -x ${INSTALLED} ]; then echo "WARN|OpenFlux уже установлен: добавится канал $OF_CHANNEL, остальные каналы не тронуты"
else echo "OK|OpenFlux не установлен"; fi
case "$(uname -m)" in x86_64|aarch64|armv7l) echo "OK|архитектура $(uname -m)";; *) echo "FAIL|архитектура $(uname -m) не поддерживается";; esac`,
  plan: (a) => [
    'Скачать node-install.sh с GitHub (закреплённый коммит) и сверить SHA-256',
    a.OF_CUPS === 'yes'
      ? 'Создать 4 комнаты cups.online (не дал - канал без них)'
      : 'Без комнат cups.online',
    `Установщик: пользователь openflux-node, ядро OpenFlux с GitHub (SHA-256), шаблон openflux-node@.service, канал ${a.OF_CHANNEL} с новым ключом на свободном порту (ufw откроет порт)`,
    [
      'Транспорты: прямое подключение',
      a.OF_CUPS === 'yes' ? 'cups.online' : '',
      a.OF_VYANDEX ? 'Яндекс Документ' : '',
      a.OF_MAILRU ? 'документ Mail.ru' : '',
    ]
      .filter(Boolean)
      .join(', '),
    a.OF_AUTOUPDATE === 'yes'
      ? 'Автообновление ядра: таймер раз в 6 часов, откат, если нода не поднялась'
      : 'Без автообновления ядра',
  ],
  after:
    'Ссылка на канал - во вкладке OpenFlux сервера. Если сервер участвует в глобальных клиентах, сверка заведёт каналы клиентам.',
};

export const openfluxUninstallCmd: CommandDef = {
  id: 'openflux-uninstall',
  title: 'Удалить OpenFlux',
  group: 'maintain',
  service: 'OpenFlux',
  description:
    'Снести ноду OpenFlux установщиком проекта: все каналы (и клиентов панели), их порты в ufw, ядро, шаблон службы, таймер обновлений и пользователя openflux-node.',
  params: [
    {
      name: 'CONFIRM',
      label: 'Подтверждение',
      type: 'select',
      default: 'no',
      required: true,
      options: [
        { value: 'no', label: 'нет, не удалять' },
        { value: 'yes', label: 'да, удалить' },
      ],
    },
  ],
  timeoutSec: 5 * 60,
  script: `${PROLOGUE}
[ "$CONFIRM" = "yes" ] || { echo "удаление не подтверждено" >&2; exit 2; }
[ -d /etc/openflux-node ] || [ -x ${INSTALLED} ] || { echo "OpenFlux не установлен" >&2; exit 3; }
if [ -x ${INSTALLED} ]; then
  OF_INST=${INSTALLED}
else
  say "Скачиваю установщик OpenFlux (закреплённый коммит, проверка sha256)"
  ${FETCH_INSTALLER}fi
say "Удаляю OpenFlux (node-install.sh uninstall)"
sh "$OF_INST" uninstall
say "Готово"
`,
  preflight: `if [ -d /etc/openflux-node ]; then n=$(find /etc/openflux-node -mindepth 1 -maxdepth 1 -type d | wc -l); echo "WARN|OpenFlux установлен, каналов: $n - все пропадут, приложения перестанут подключаться"; else echo "FAIL|OpenFlux не установлен"; fi`,
  plan: () => [
    'node-install.sh uninstall: остановить и удалить все каналы openflux-node@*, закрыть их порты в ufw',
    'Удалить /opt/openflux-node, /etc/openflux-node, /var/lib/openflux-node, шаблон службы, таймер обновлений и пользователя openflux-node',
    'Привязки клиентов панели к OpenFlux на этом сервере снимутся при следующей сверке',
  ],
  dropsBindings: ['openflux'],
};
