#!/bin/bash
# Установка и обновление VPS Panel на сервере панели.
#
#   git clone https://github.com/iKonan-ru/vps-panel.git /opt/vps-panel
#   /opt/vps-panel/deploy/install.sh
#
# Первый запуск спрашивает домен панели, имя подписок и почту для Let's Encrypt, проверяет DNS
# и порты, ставит недостающее (docker, fail2ban, git, make), пишет deploy/.env с новым
# SESSION_SECRET, собирает агента и файлы сервисов (Go скачивается во временную папку, если
# его нет), запускает контейнеры и ждёт ответа /api/health. Сертификаты Let's Encrypt
# получает Caddy сам при первом запросе к имени.
# Повторный запуск - обновление: git pull (если это клон без своих правок), сборка, пересборка
# контейнеров. deploy/.env и deploy/data не трогаются.
# Без вопросов: PANEL_DOMAIN, ACME_EMAIL и SUB_DOMAIN (можно пустой) в окружении и ключ -y.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
YES=0
[ "${1:-}" = "-y" ] && YES=1

say() { printf '\n== %s\n' "$*"; }
warn() { printf '!! %s\n' "$*" >&2; }
die() {
  printf 'ОШИБКА: %s\n' "$*" >&2
  exit 1
}
# ask <вопрос> <по умолчанию> - ответ в $REPLY; с -y - значение по умолчанию
ask() {
  if [ "$YES" = 1 ]; then REPLY="$2"; return; fi
  read -r -p "$1${2:+ [$2]}: " REPLY </dev/tty 2>/dev/null ||
    die "нет терминала для вопросов: задайте PANEL_DOMAIN, ACME_EMAIL, SUB_DOMAIN и запустите с -y"
  [ -n "$REPLY" ] || REPLY="$2"
}
# confirm <вопрос> - да/нет, с -y - да
confirm() {
  [ "$YES" = 1 ] && return 0
  local a
  read -r -p "$1 [y/N]: " a </dev/tty 2>/dev/null || die "нет терминала для вопроса: запустите с -y"
  case "$a" in [yYдД]*) return 0 ;; *) return 1 ;; esac
}
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
# A-записи имени (только IPv4)
resolve4() { { getent ahostsv4 "$1" 2>/dev/null || true; } | awk '{print $1}' | sort -u | tr '\n' ' '; }

[ "$(id -u)" = 0 ] || die "запускать от root (sudo $0)"
command -v apt-get >/dev/null || warn "не Debian/Ubuntu: недостающие пакеты ставить руками"

pkg() { # пакеты, которых нет
  local miss=() p
  for p in "$@"; do dpkg -s "$p" >/dev/null 2>&1 || miss+=("$p"); done
  [ "${#miss[@]}" = 0 ] && return 0
  command -v apt-get >/dev/null || die "нужны пакеты: ${miss[*]}"
  say "ставлю пакеты: ${miss[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${miss[@]}" >/dev/null
}
pkg curl git make python3 openssl ca-certificates iproute2

# ---------------------------------------------------------------- режим
if [ -f "$ENV_FILE" ]; then
  MODE=update
  DOMAIN="$(env_get PANEL_DOMAIN)"
  SUB="$(env_get SUB_DOMAIN)"
  [ -n "$DOMAIN" ] || die "в $ENV_FILE нет PANEL_DOMAIN"
  say "обновление панели $DOMAIN"
  if [ -d "$ROOT/.git" ] && [ -z "${VPSP_PULLED:-}" ]; then
    if [ -n "$(git -C "$ROOT" status --porcelain --untracked-files=no)" ]; then
      warn "в $ROOT есть свои правки - git pull пропущен, собираю то, что есть"
    elif confirm "Забрать новую версию из git (git pull)?"; then
      old="$(git -C "$ROOT" rev-parse HEAD)"
      git -C "$ROOT" pull --ff-only
      # новая версия скрипта могла поменяться - дальше работает она
      if [ "$(git -C "$ROOT" rev-parse HEAD)" != "$old" ]; then
        VPSP_PULLED=1 exec "$ROOT/deploy/install.sh" "$@"
      fi
    fi
  fi
else
  MODE=install
  if [ -f "$DEPLOY/data/panel.db" ]; then
    die "в $DEPLOY/data уже есть база панели, а $ENV_FILE нет. Новый SESSION_SECRET сделает зашифрованные в базе доступы и ключи нечитаемыми: верните прежний .env (или panel.env из бэкапа панели) и запустите скрипт снова"
  fi
  say "установка VPS Panel в $ROOT"
  DOMAIN="${PANEL_DOMAIN:-}"
  while :; do
    ask "Домен панели (A-запись на этот сервер)" "$DOMAIN"
    DOMAIN="$(echo "$REPLY" | tr 'A-Z' 'a-z')"
    echo "$DOMAIN" | grep -qE '^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z0-9-]{2,}$' && break
    [ "$YES" = 1 ] && die "PANEL_DOMAIN не задан или неверный: '$DOMAIN'"
    warn "нужен домен вида panel.example.com (IDN - в punycode, xn--...)"
  done
  SUB="${SUB_DOMAIN-sub.$DOMAIN}"
  ask "Имя для подписок и личных страниц клиентов (своя A-запись; - = на домене панели)" "${SUB:--}"
  SUB="$(echo "$REPLY" | tr 'A-Z' 'a-z')"
  [ "$SUB" = "-" ] && SUB=""
  EMAIL="${ACME_EMAIL:-}"
  while :; do
    ask "Почта для Let's Encrypt (письма об истечении сертификатов)" "$EMAIL"
    EMAIL="$REPLY"
    echo "$EMAIL" | grep -qE '^[^@ ]+@[^@ ]+\.[^@ ]+$' && break
    [ "$YES" = 1 ] && die "ACME_EMAIL не задан или неверный"
    warn "нужен адрес почты"
  done

  say "проверка DNS"
  IP="$(curl -4 -fsS -m 10 https://api.ipify.org 2>/dev/null || curl -4 -fsS -m 10 https://ifconfig.me 2>/dev/null || true)"
  [ -n "$IP" ] && echo "внешний адрес сервера: $IP" || warn "внешний адрес сервера определить не удалось"
  dns_bad=0
  for name in "$DOMAIN" ${SUB:+"$SUB"}; do
    got="$(resolve4 "$name")"
    if [ -z "$got" ]; then
      warn "$name: A-записи нет"
      dns_bad=1
    elif [ -n "$IP" ] && ! echo " $got" | grep -q " $IP "; then
      warn "$name указывает на $got, а не на $IP"
      dns_bad=1
    else
      echo "$name -> $got ок"
    fi
  done
  wild="vpsp-check-$RANDOM.$DOMAIN"
  if [ -n "$(resolve4 "$wild")" ]; then
    echo "*.$DOMAIN есть: панели сервисов через поддомены будут работать"
  else
    warn "*.$DOMAIN в DNS нет: панель работает, но панели сервисов (3X-UI, MTProxyL) через поддомены не откроются, пока не заведена wildcard-запись на этот сервер"
  fi
  if [ "$dns_bad" = 1 ]; then
    warn "Caddy не получит сертификат, пока имена не указывают на этот сервер"
    confirm "Продолжить всё равно?" || exit 1
  fi

  say "проверка портов 80 и 443"
  busy="$(ss -ltnupH 2>/dev/null | awk '$5 ~ /:(80|443)$/' || true)"
  if [ -n "$busy" ]; then
    echo "$busy"
    die "порты 80 или 443 заняты: их должен слушать Caddy панели"
  fi
  echo "свободны"
fi

# ---------------------------------------------------------------- docker
if ! command -v docker >/dev/null; then
  say "docker не установлен"
  confirm "Поставить docker официальным скриптом get.docker.com?" || die "нужен docker с compose plugin"
  curl -fsSL https://get.docker.com | sh
fi
docker compose version >/dev/null 2>&1 || die "нет docker compose plugin (пакет docker-compose-plugin)"

# ---------------------------------------------------------------- .env и данные
if [ "$MODE" = install ]; then
  say "пишу $ENV_FILE"
  SECRET="$(openssl rand -base64 48 | tr -d '\n')"
  python3 - "$DEPLOY/.env.example" "$ENV_FILE" "$DOMAIN" "$EMAIL" "$SECRET" "$SUB" <<'PY'
import sys
src, dst, domain, email, secret, sub = sys.argv[1:7]
vals = {"PANEL_DOMAIN": domain, "ACME_EMAIL": email, "SESSION_SECRET": secret, "SUB_DOMAIN": sub}
out = []
for line in open(src, encoding="utf-8"):
    k = line.split("=", 1)[0]
    out.append(f"{k}={vals[k]}\n" if "=" in line and not line.startswith("#") and k in vals else line)
open(dst, "w", encoding="utf-8").write("".join(out))
PY
  chmod 600 "$ENV_FILE"
  echo "SESSION_SECRET - ключ шифрования данных в базе: храните копию .env (или бэкап панели) отдельно"
fi
mkdir -p "$DEPLOY/data"
chown -R 1000:1000 "$DEPLOY/data"
chmod 700 "$DEPLOY/data"

# ---------------------------------------------------------------- сборка
say "сборка агента и файлов сервисов"
TMP="$(mktemp -d /var/tmp/vps-panel-build.XXXXXX)"
trap 'rm -rf "$TMP"' EXIT
go_ok() { command -v go >/dev/null && go version | grep -qE 'go1\.(2[5-9]|[3-9][0-9])'; }
if ! go_ok; then
  case "$(uname -m)" in x86_64) GOARCH_HOST=amd64 ;; aarch64 | arm64) GOARCH_HOST=arm64 ;; *) die "архитектура $(uname -m) не поддерживается" ;; esac
  read -r gofile gosha < <(curl -fsSL -m 30 'https://go.dev/dl/?mode=json' | python3 -c '
import json, sys
arch = sys.argv[1]
for rel in json.load(sys.stdin):
    if not rel.get("stable"):
        continue
    for f in rel["files"]:
        if f["os"] == "linux" and f["arch"] == arch and f["kind"] == "archive":
            print(f["filename"], f["sha256"])
            sys.exit(0)
sys.exit(1)' "$GOARCH_HOST") || die "не удалось узнать последнюю версию Go на go.dev"
  echo "Go не найден, скачиваю $gofile во временную папку"
  curl -fsSL -m 300 "https://go.dev/dl/$gofile" -o "$TMP/go.tgz"
  echo "$gosha  $TMP/go.tgz" | sha256sum -c --quiet || die "контрольная сумма Go не совпала"
  tar -C "$TMP" -xzf "$TMP/go.tgz"
  export PATH="$TMP/go/bin:$PATH"
fi
export GOTOOLCHAIN=local GOPATH="$TMP/gopath" GOCACHE="$TMP/gocache" GOFLAGS=-modcacherw
GO="$(command -v go)"
export GO
make -s -C "$ROOT/apps/agent" build-all
mkdir -p "$DEPLOY/agent-dist"
cp "$ROOT"/dist/* "$DEPLOY/agent-dist/"
chmod -R a+rX "$DEPLOY/agent-dist"
echo "агент $(cat "$ROOT/dist/version.txt")"
# сборки сторонних программ с закреплёнными версиями: заново, только когда поменялся скрипт
# сборки (версия, правки) - отпечаток скрипта лежит рядом с результатом
build_files() { # имя (wdtt, naive)
  local stamp="$DEPLOY/files/$1/.built" want
  want="$(sha256sum "$ROOT/tools/build-$1.sh" | cut -c1-64)"
  if [ "$(cat "$stamp" 2>/dev/null)" = "$want" ]; then
    echo "$1: собран, скрипт сборки не менялся"
    return
  fi
  sh "$ROOT/tools/build-$1.sh"
  echo "$want" >"$stamp"
}
build_files wdtt
build_files naive
chmod -R a+rX "$DEPLOY/files"

# ---------------------------------------------------------------- запуск
say "сборка и запуск контейнеров (первый раз - несколько минут)"
cd "$DEPLOY"
if ! docker compose up -d --build; then
  die "docker compose не поднялся. Если не скачиваются образы node:22-alpine, alpine:3, caddy:2-alpine (Docker Hub недоступен с сервера) - загрузите их через зеркало или docker save/load и запустите скрипт снова"
fi

# Caddyfile примонтирован файлом: git pull подменяет inode, и контейнер видит старый. Изменился -
# проверить новый в работающем Caddy и пересоздать контейнер.
if [ "$MODE" = update ]; then
  in_ct="$(docker compose exec -T caddy md5sum /etc/caddy/Caddyfile 2>/dev/null | cut -c1-32 || true)"
  if [ "$in_ct" != "$(md5sum Caddyfile | cut -c1-32)" ]; then
    if docker compose exec -T caddy caddy validate --adapter caddyfile --config /dev/stdin <Caddyfile >/dev/null 2>&1; then
      docker compose up -d --force-recreate caddy && echo "caddy: конфиг обновлён"
    else
      warn "новый Caddyfile не прошёл проверку - caddy работает со старым"
    fi
  fi
fi

say "жду ответа https://$DOMAIN/api/health"
ok=0
for _ in $(seq 1 60); do
  if curl -fsS -m 10 "https://$DOMAIN/api/health" >/dev/null 2>&1; then ok=1; break; fi
  sleep 5
done
if [ "$ok" = 1 ]; then
  echo "панель отвечает"
else
  warn "за 5 минут https://$DOMAIN/api/health не ответил: проверьте DNS и журналы (docker compose logs caddy panel)"
fi

# ---------------------------------------------------------------- firewall и fail2ban
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q '^Status: active'; then
  say "ufw: разрешаю 80/tcp, 443/tcp, 443/udp"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  ufw allow 443/udp >/dev/null
fi
say "fail2ban для входа в панель"
pkg fail2ban iptables
cp "$DEPLOY/fail2ban-panel.conf" /etc/fail2ban/filter.d/vps-panel.conf
cp "$DEPLOY/fail2ban-panel.jail" /etc/fail2ban/jail.d/vps-panel.conf
log="$(docker volume inspect -f '{{.Mountpoint}}' deploy_caddy_data 2>/dev/null || true)/access.log"
if [ -f "$log" ]; then
  # restart, не reload: при перезагрузке jail новое действие (banaction) не ставится
  if systemctl restart fail2ban; then
    echo "fail2ban: jail vps-panel включён (в Ubuntu fail2ban включает и jail sshd: 5 неудачных входов по ssh - бан адреса)"
  else
    warn "fail2ban не перезапустился: journalctl -u fail2ban"
  fi
else
  warn "лога Caddy ($log) ещё нет: fail2ban перезапустить после первого входа - systemctl restart fail2ban"
fi

say "готово"
if [ "$MODE" = install ]; then
  cat <<MSG
Панель: https://$DOMAIN
${SUB:+Подписки и личные страницы: https://$SUB
}Сразу откройте панель и пройдите мастер первой настройки (администратор, пароль, 2FA):
до этого он открыт любому, кто первым зайдёт на адрес.
Затем - "Серверы" -> "Добавить сервер". Бэкап панели (Настройки) - включить сразу.
Обновление - снова deploy/install.sh.
MSG
else
  echo "Панель обновлена: https://$DOMAIN"
fi
