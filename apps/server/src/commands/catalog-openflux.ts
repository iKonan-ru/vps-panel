import type { CommandDef } from './types.js';
import { PROLOGUE } from './util.js';

/**
 * OpenFlux: установщик node-install.sh по закреплённому коммиту со сверкой sha256 - тот же, что
 * у агента (ofInstallerURL, ofInstallerSHA256, ofCoreVersion), меняются вместе. Установщик ставит
 * ядро только вместе с каналом, поэтому установка - это первый канал. Автообновление ядра
 * выключено: ядро закреплено установщиком и обновляется вместе с панелью.
 */
const INSTALLER_URL =
  'https://raw.githubusercontent.com/p1neappleXpress/OpenFlux/e9c29ad968606696802ee2921958a6be294c515d/deploy/node-install.sh';
const INSTALLER_SHA256 = 'f13d05c9876e823a187ce7976d78278f117b725f259dd4f3e250389b538ad0e6';
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

/**
 * Комнаты Avito Code: как агент (ofAvitoRooms) - анонимный POST /web/1/code/room, 16 комнат (пары
 * передача и приём), список v2 base64url(JSON); отказ - с теми, что есть, меньше пары - без Avito.
 */
const AVITO_ROOMS = `of_avito_rooms() {
  local ids="" id n=0 i
  for i in $(seq 1 16); do
    id=$(curl -fsS --max-time 30 -X POST -A "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:155.0) Gecko/20100101 Firefox/155.0" \
      -H 'Origin: https://code.avito.ru' https://code.avito.ru/web/1/code/room 2>/dev/null \
      | grep -oE '"room":\\{"id":"[A-Za-z0-9_-]+"' | grep -oE '[A-Za-z0-9_-]+"$' | tr -d '"' || true)
    [ -n "$id" ] || break
    ids="\${ids:+$ids,}\\"$id\\""; n=$((n + 1))
    sleep 0.3
  done
  [ "$n" -ge 2 ] || return 0
  [ $((n % 2)) = 0 ] || ids="\${ids%,*}"
  printf '{"v":2,"rooms":[%s]}' "$ids" | base64 -w0 | tr '+/' '-_' | tr -d '='
}
`;

export const openfluxCmd: CommandDef = {
  id: 'openflux',
  title: 'OpenFlux',
  group: 'install',
  service: 'OpenFlux',
  description:
    'Нода для приложения OpenFlux с первым каналом. Канал работает напрямую по TCP и, если заданы, через комнаты cups.online и Avito, документы Яндекса и Mail.ru, Телемост и Яндекс Доску.',
  params: [
    {
      name: 'OF_CHANNEL',
      label: 'Имя первого канала',
      type: 'string',
      default: 'main',
      required: true,
      pattern: '^[a-z0-9][a-z0-9-]{0,30}$',
      hint: 'a-z, 0-9 и дефис; каналы клиентов создаются автоматически',
    },
    {
      name: 'OF_CUPS',
      label: 'Комнаты cups.online',
      type: 'select',
      default: 'yes',
      hint: 'запасной транспорт',
      options: [
        { value: 'yes', label: 'создать' },
        { value: 'no', label: 'не создавать' },
      ],
    },
    {
      name: 'OF_AVITO',
      label: 'Комнаты Avito',
      type: 'select',
      default: 'yes',
      hint: 'запасной транспорт',
      options: [
        { value: 'yes', label: 'создать' },
        { value: 'no', label: 'не создавать' },
      ],
    },
    {
      name: 'OF_VYANDEX',
      label: 'Яндекс Документ',
      type: 'string',
      secret: true,
      pattern: '^https://(docs|disk)\\.yandex\\.(ru|com|by|kz|uz)/edit/d/[A-Za-z0-9_-]{16,200}$',
      hint: 'необязательно; ссылка https://docs.yandex.ru/edit/d/... с правом редактирования',
    },
    {
      name: 'OF_MAILRU',
      label: 'Документ Mail.ru',
      type: 'string',
      secret: true,
      pattern: '^https://cloud\\.mail\\.ru/public/[A-Za-z0-9_-]{2,64}/[A-Za-z0-9_-]{2,128}$',
      hint: 'необязательно; ссылка https://cloud.mail.ru/public/... с правом редактирования',
    },
    {
      name: 'OF_TELEMOST',
      label: 'Телемост',
      type: 'string',
      secret: true,
      pattern: '^https://telemost\\.yandex\\.ru/j/[0-9]{6,32}$',
      hint: 'необязательно; ссылка на конференцию https://telemost.yandex.ru/j/...',
    },
    {
      name: 'OF_BOARDS',
      label: 'Яндекс Доска',
      type: 'string',
      secret: true,
      pattern: '^https://boards\\.yandex\\.ru/whiteboard/\\?hash=[0-9a-f]{32}$',
      hint: 'необязательно; доска, открытая гостям: https://boards.yandex.ru/whiteboard/?hash=...',
    },
  ],
  timeoutSec: 10 * 60,
  script: `${PROLOGUE}
need curl || apt_install curl
say "Скачиваю установщик OpenFlux (закреплённый коммит, проверка sha256)"
${FETCH_INSTALLER}${CUPS_ROOMS}${AVITO_ROOMS}
OF_ROOMS=""
if [ "$OF_CUPS" = "yes" ]; then
  say "Создаю комнаты cups.online"
  OF_ROOMS=$(of_cups_rooms)
  [ -n "$OF_ROOMS" ] && echo "комнаты созданы" || echo "cups.online не отдал комнат - канал будет без них"
fi
OF_AVITO_ROOMS=""
if [ "$OF_AVITO" = "yes" ]; then
  say "Создаю комнаты Avito"
  OF_AVITO_ROOMS=$(of_avito_rooms)
  [ -n "$OF_AVITO_ROOMS" ] && echo "комнаты созданы" || echo "Avito не отдал комнат - канал будет без них"
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
  [ -n "$OF_TELEMOST" ] && printf 'telemost=%s\\n' "$OF_TELEMOST"
  [ -n "$OF_BOARDS" ] && printf 'boards=%s\\n' "$OF_BOARDS"
  [ -n "$OF_AVITO_ROOMS" ] && printf 'avito=%s\\n' "$OF_AVITO_ROOMS"
  [ -n "$OF_ROOMS" ] && printf 'cupsonline=%s\\n' "$OF_ROOMS"
  printf 'autoupdate=no\\n'
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
elif [ -x ${INSTALLED} ]; then echo "WARN|OpenFlux уже установлен: будет добавлен канал $OF_CHANNEL, остальные не изменятся"
else echo "OK|OpenFlux не установлен"; fi
case "$(uname -m)" in x86_64|aarch64|armv7l) echo "OK|архитектура $(uname -m)";; *) echo "FAIL|архитектура $(uname -m) не поддерживается";; esac`,
  plan: (a) => [
    'Скачать установщик OpenFlux и проверить контрольную сумму',
    a.OF_CUPS === 'yes' ? 'Создать комнаты cups.online' : 'Без комнат cups.online',
    a.OF_AVITO === 'yes' ? 'Создать комнаты Avito' : 'Без комнат Avito',
    `Установить OpenFlux и канал ${a.OF_CHANNEL} на свободном порту`,
    [
      'Транспорты: прямое подключение',
      a.OF_CUPS === 'yes' ? 'cups.online' : '',
      a.OF_AVITO === 'yes' ? 'Avito' : '',
      a.OF_VYANDEX ? 'Яндекс Документ' : '',
      a.OF_MAILRU ? 'документ Mail.ru' : '',
      a.OF_TELEMOST ? 'Телемост' : '',
      a.OF_BOARDS ? 'Яндекс Доска' : '',
    ]
      .filter(Boolean)
      .join(', '),
    'Ядро закреплённой версии, обновляется вместе с панелью',
  ],
  after:
    'Ссылка на канал\u00a0\u2014 на вкладке OpenFlux сервера. Каналы клиентам создаются при синхронизации.',
};

export const openfluxUninstallCmd: CommandDef = {
  id: 'openflux-uninstall',
  title: 'Удалить OpenFlux',
  group: 'maintain',
  service: 'OpenFlux',
  description:
    'Удаляет OpenFlux со всеми каналами, включая каналы клиентов. Приложения перестанут подключаться к этому серверу.',
  params: [
    {
      name: 'CONFIRM',
      label: 'Подтверждение',
      type: 'select',
      default: 'no',
      required: true,
      options: [
        { value: 'no', label: 'не удалять' },
        { value: 'yes', label: 'удалить' },
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
  preflight: `if [ -d /etc/openflux-node ]; then n=$(find /etc/openflux-node -mindepth 1 -maxdepth 1 -type d | wc -l); echo "WARN|каналов OpenFlux: $n, все будут удалены, приложения перестанут подключаться"; else echo "FAIL|OpenFlux не установлен"; fi`,
  plan: () => [
    'Удалить все каналы и закрыть их порты',
    'Удалить OpenFlux с настройками и автообновлением',
    'Отключить клиентов от OpenFlux на этом сервере',
  ],
  dropsBindings: ['openflux'],
};
