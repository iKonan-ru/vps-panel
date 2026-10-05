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
