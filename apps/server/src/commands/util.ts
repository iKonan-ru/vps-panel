import { randomBytes, randomInt } from 'node:crypto';
import { slugify } from '../lib/panel-proxy.js';

export const rndPort =
  (min = 20000, max = 60000) =>
  () =>
    String(randomInt(min, max));
export const rndHex = (bytes: number) => () => randomBytes(bytes).toString('hex');
export const rndPath = () => `/${randomBytes(9).toString('base64url')}/`;
export const rndPassword = () => randomBytes(12).toString('base64url');

/** Общий пролог скриптов: строгий режим, отметки времени, PANEL_URL и SERVER_* уже в окружении. */
export const PROLOGUE = `set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
say() { printf '\\n== %s\\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1; }
apt_install() { need apt-get || { echo "поддерживаются только Debian и Ubuntu" >&2; exit 2; }; dpkg --configure -a >/dev/null 2>&1 || true; apt-get update -qq; apt-get install -y -qq "$@"; }
fetch() { curl -fsSL --retry 3 --retry-delay 2 "$@"; }
`;

/**
 * Прокси для браузера (naive) и порт 443 - общие функции команд naive и MTProxyL. У прокси 443 в
 * одном из режимов (config.json прокси): listen - Caddy слушает 443 сам (443 был свободен),
 * mask - 443 держит MTProxyL, его telemt по SNI имени прокси передаёт соединение на порт Caddy,
 * none - прокси только на своём порту. Порядок установки любой: установка MTProxyL на 443
 * забирает 443 у прокси (naive_443 none до установщика, маска и naive_443 mask после), удаление
 * MTProxyL возвращает 443 прокси (naive_443 listen).
 * - port_owner <порт> - процесс, который слушает TCP-порт (пусто - свободен);
 * - mt_port - порт прокси MTProxyL из его конфига;
 * - naive_installed, naive_unit_active, naive_get <ключ> (из config.json), naive_mode;
 * - naive_443 <режим> - режим в config.json, Caddyfile от агента, перезапуск службы, если
 *   Caddyfile изменился; listen, который Caddy не принял (агент старее этой правки), - none;
 * - naive_mask_on <имя> <порт> - маска telemt и перезапуск прокси Telegram (ошибка - код не 0,
 *   скрипт не падает).
 */
export const NAIVE_FUNCS = `port_owner() { ss -Hltnp "sport = :$1" 2>/dev/null | head -1 | grep -o 'users:(("[^"]*"' | cut -d'"' -f2; }
mt_port() { grep -E '^[[:space:]]*port[[:space:]]*=' /opt/mtproxyl/mtproxy/config.toml 2>/dev/null | head -1 | grep -oE '[0-9]+' || true; }
naive_unit_active() { systemctl is-active --quiet vps-naive 2>/dev/null; }
naive_installed() { [ -f /etc/systemd/system/vps-naive.service ] && [ -f /etc/vps-naive/config.json ]; }
naive_get() { python3 -c 'import json, sys
v = json.load(open("/etc/vps-naive/config.json")).get(sys.argv[1], "")
print(str(v).lower() if isinstance(v, bool) else v)' "$1" 2>/dev/null || true; }
naive_mode() { if [ "$(naive_get mask443)" = true ]; then echo mask; elif [ "$(naive_get listen443)" = true ]; then echo listen; else echo none; fi; }
naive_cfg443() {
python3 - "$1" <<'PY'
import json, sys
p = "/etc/vps-naive/config.json"
c = json.load(open(p))
c["listen443"] = sys.argv[1] == "listen"
c["mask443"] = sys.argv[1] == "mask"
with open(p, "w") as f:
    json.dump(c, f, indent=2)
PY
chmod 600 /etc/vps-naive/config.json
}
naive_443() {
  local mode=$1 before after
  before=$(sha256sum /etc/vps-naive/Caddyfile 2>/dev/null || true)
  naive_cfg443 "$mode"
  /usr/local/bin/vps-agent -naive-render
  if [ "$mode" = listen ] && ! runuser -u vps-naive -- /opt/vps-naive/caddy validate --config /etc/vps-naive/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "ВНИМАНИЕ: Caddy не принял 443 (обнови агента сервера и повтори установку прокси для браузера) - прокси только на порту $(naive_get port)"
    mode=none
    naive_cfg443 none
    /usr/local/bin/vps-agent -naive-render
  fi
  after=$(sha256sum /etc/vps-naive/Caddyfile)
  if [ "$before" != "$after" ] || ! naive_unit_active; then
    systemctl restart vps-naive
    sleep 2
  fi
  case "$mode" in
    listen) echo "прокси для браузера: 443 - Caddy сам, служба $(systemctl is-active vps-naive || true)";;
    mask) echo "прокси для браузера: 443 - маска MTProxyL, служба $(systemctl is-active vps-naive || true)";;
    *) echo "прокси для браузера: только порт $(naive_get port), служба $(systemctl is-active vps-naive || true)";;
  esac
}
naive_mask_on() {
  mtproxyl expert set --raw censorship.exclusive_mask "$1" "127.0.0.1:$2" --no-apply &&
    mtproxyl expert apply </dev/null &&
    mtproxyl restart </dev/null &&
    sleep 3
}
`;

/** Скрипт установки docker (официальный установщик), если его ещё нет. */
export const ENSURE_DOCKER = `if ! need docker; then
  say "Docker не найден - ставлю официальным установщиком"
  fetch https://get.docker.com -o /tmp/get-docker.sh
  sh /tmp/get-docker.sh
  rm -f /tmp/get-docker.sh
  systemctl enable --now docker
fi
docker --version
`;

/**
 * Адрес входа в панель сервиса через VPS Panel (поддомен, lib/panel-proxy.ts): ссылка открывает
 * её вход и ведёт на <слаг сервера>-<вид>.<домен>.
 */
export function openPanelUrl(panelUrl: string, serverName: string, kind: 'xui' | 'mtproxyl') {
  return `${panelUrl.replace(/\/+$/, '')}/api/proxy/open/${slugify(serverName)}-${kind}`;
}

/**
 * Функции для команд 3X-UI:
 * - xui_sub_off - выключить свой сервер подписок 3X-UI (subEnable = false): подписку клиентам
 *   отдаёт VPS Panel, а наружу он открывал порт 2096 с токенами клиентов в адресе. База -
 *   PostgreSQL (XUI_DB_TYPE в /etc/default/x-ui, установщик 3.9 ставит её по умолчанию) или
 *   /etc/x-ui/x-ui.db; пароль PostgreSQL - в окружении psql, не в аргументах;
 * - xui_panel_ufw_close <порт> - убрать ручное правило ufw для порта (установщик 3X-UI
 *   открывает порт панели; 2096 - сервер подписок): панель на 127.0.0.1, подписки выключены.
 * Обе не роняют скрипт: 3X-UI остановлена на время правки и должна запуститься в любом случае.
 */
export const XUI_FUNCS = `xui_sub_off() {
need python3 || apt_install python3
if grep -qiE '^[[:space:]]*(export[[:space:]]+)?XUI_DB_TYPE=["'"'"']?postgres' /etc/default/x-ui 2>/dev/null; then
  need psql || apt_install postgresql-client
fi
python3 - <<'PY'
import os, sqlite3, subprocess, sys
from urllib.parse import urlparse, parse_qs
env = {}
try:
    for line in open("/etc/default/x-ui"):
        line = line.strip()
        if line.startswith("export "):
            line = line[7:]
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("\\"'")
except FileNotFoundError:
    pass
if env.get("XUI_DB_TYPE", "").lower() == "postgres" and env.get("XUI_DB_DSN"):
    u = urlparse(env["XUI_DB_DSN"])
    e = dict(os.environ, PGHOST=u.hostname or "127.0.0.1", PGDATABASE=(u.path or "/").lstrip("/"))
    if u.port:
        e["PGPORT"] = str(u.port)
    if u.username:
        e["PGUSER"] = u.username
    if u.password:
        e["PGPASSWORD"] = u.password
    mode = parse_qs(u.query).get("sslmode")
    if mode:
        e["PGSSLMODE"] = mode[0]
    sql = ("update settings set value = 'false' where key = 'subEnable'; "
           "insert into settings (key, value) select 'subEnable', 'false' "
           "where not exists (select 1 from settings where key = 'subEnable');")
    p = subprocess.run(["psql", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], env=e,
                       capture_output=True, text=True, timeout=30)
    if p.returncode != 0:
        print("PostgreSQL: " + p.stderr.strip(), file=sys.stderr)
        sys.exit(1)
    print("subEnable = false (PostgreSQL)")
elif os.path.exists("/etc/x-ui/x-ui.db"):
    db = sqlite3.connect("/etc/x-ui/x-ui.db")
    if db.execute("update settings set value = 'false' where key = 'subEnable'").rowcount == 0:
        db.execute("insert into settings (key, value) values ('subEnable', 'false')")
    db.commit()
    print("subEnable = false (sqlite)")
else:
    print("база 3X-UI не найдена", file=sys.stderr)
    sys.exit(1)
PY
}
xui_panel_ufw_close() {
  local port="$1"
  [ -n "$port" ] && need ufw || return 0
  if ufw status | grep -qE "^$port(/tcp)?[[:space:]]+ALLOW[[:space:]]"; then
    ufw delete allow "$port" >/dev/null 2>&1 || true
    ufw delete allow "$port/tcp" >/dev/null 2>&1 || true
    echo "ufw: правило для порта $port убрано"
  fi
}`;

/**
 * Зеркальные правила WDTT: deploy.sh копирует в iptables INPUT (ACCEPT, комментарий
 * WDTT_MIRRORED) все порты, открытые на момент установки, и вставляет их выше ufw - порт,
 * закрытый port-sync (сервис удалили), оставался открыт. Где порты ведут ufw и port-sync, эти
 * правила не нужны: port-sync сам открывает порты WDTT (wdtt-server и его WireGuard).
 */
export const WDTT_FW_FUNCS = `portsync_governs() { ufw status 2>/dev/null | grep -q '^Status: active' && [ -x /usr/local/sbin/vps-portsync ]; }
wdtt_mirrors_drop() { # [порт...] - только эти; без аргументов - все
  need iptables || return 0
  iptables -S INPUT 2>/dev/null | grep -- '--comment WDTT_MIRRORED' | while read -r rule; do
    port=$(printf '%s\\n' "$rule" | grep -o -- '--dport [0-9]*' | awk '{print $2}')
    if [ $# -eq 0 ] || printf ' %s ' "$*" | grep -q " $port "; then
      # shellcheck disable=SC2086
      iptables $(printf '%s' "$rule" | sed 's/^-A /-D /') 2>/dev/null || true
    fi
  done
  need netfilter-persistent && netfilter-persistent save >/dev/null 2>&1 || true
}
`;
