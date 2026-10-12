#!/bin/sh
# Выкладка панели на боевой сервер: код + собранные бинарники агента, пересборка контейнера panel.
# Использование: deploy/push.sh <ssh-ключ> [user@host] (иначе PANEL_HOST)
# Права выставляются явно: контейнер panel работает от uid 1000 (node) и должен читать
# agent-dist и files, а rsync -a переносил бы 0700 и чужого владельца из песочницы.
set -eu
KEY="${1:?путь к ssh-ключу}"
HOST="${2:-${PANEL_HOST:?сервер панели: второй аргумент user@host или PANEL_HOST}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ключи хоста сервера панели - KNOWN_HOSTS=<файл> (иначе ~/.ssh/known_hosts); проверка строгая
SSH="ssh -i $KEY -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"

# сервер переведён на релизы (vps-panel migrate): исходники туда больше не выкладываются -
# новая версия ставится релизом (tools/release.sh), иначе две панели делили бы порты
if $SSH "$HOST" 'test -f /opt/vps-panel/compose.yml'; then
  echo "на сервере установка из релиза: выкладка исходников отключена - tools/release.sh"
  exit 1
fi

# коммит - в отчёт о сборке (data/deploy.json), его показывает панель; незакоммиченное - с пометкой
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo '?')"
git -C "$ROOT" diff --quiet HEAD 2>/dev/null || COMMIT="$COMMIT+правки"
echo "выкладка $COMMIT: копирую код на сервер"
rsync -rlt --delete --chmod=D755,F644 --chown=root:root -e "$SSH" \
  --exclude node_modules --exclude .git --exclude '*/dist' --exclude dist \
  --exclude deploy/data --exclude deploy/.env --exclude deploy/agent-dist \
  --exclude apps/server/data --exclude 'apps/server/:memory:' --exclude .idea \
  --exclude .ship.env \
  "$ROOT/" "$HOST:/opt/vps-panel/"
rsync -rlt --chmod=D755,F644 --chown=root:root -e "$SSH" "$ROOT/dist/" "$HOST:/opt/vps-panel/deploy/agent-dist/"

echo "код на сервере, ставлю агента и запускаю сборку"
# Сборка образа идёт в фоне на сервере (2-5 минут, ssh-сессия может не дожить): лог в
# /tmp/panel-build.log, ход - в data/deploy.json (полоса в панели), ожидание с ходом - deploy/wait.sh
# <ключ>. Агент ставится сразу.
$SSH "$HOST" 'chmod 600 /opt/vps-panel/deploy/.env 2>/dev/null; chown -R 1000:1000 /opt/vps-panel/deploy/data; chmod 700 /opt/vps-panel/deploy/data;
install -m 755 /opt/vps-panel/deploy/agent-dist/vps-agent-linux-amd64 /usr/local/bin/vps-agent && systemctl restart vps-agent
# Caddyfile примонтирован файлом: rsync подменяет inode, контейнер видит старый - пересоздаём при
# изменении. Сначала проверка в работающем Caddy: с неверным конфигом он не поднимется совсем.
cd /opt/vps-panel/deploy && if [ "$(docker compose exec -T caddy md5sum /etc/caddy/Caddyfile 2>/dev/null | cut -c1-32)" != "$(md5sum Caddyfile | cut -c1-32)" ]; then
  if docker compose exec -T caddy caddy validate --adapter caddyfile --config /dev/stdin <Caddyfile >/dev/null 2>&1; then
    docker compose up -d --force-recreate caddy >/dev/null 2>&1 && echo "caddy: конфиг обновлён"
  else echo "caddy: Caddyfile не прошёл проверку, работает старый"; fi
fi
# настройки caddy в docker-compose.yml: up пересоздаёт контейнер, только если они поменялись;
# --no-deps - иначе compose пересоздал бы и panel со старым образом до сборки нового. Вывод -
# в переменную: "| grep -q" закрывал канал на первом совпадении, и compose умирал от SIGPIPE
# между пересозданием и запуском (caddy оставался в Created, панель не отвечала).
up="$(docker compose up -d --no-deps caddy 2>&1)"; case "$up" in *Recreate*) echo "caddy: пересоздан по docker-compose.yml";; esac
# "cd X && cmd &" увёл бы в фон всю цепочку - копию оболочки с открытым выводом ssh, и ssh
# ждал бы сборку до конца (ход не виден, выкладка "висит"). Поэтому cd отдельно.
cd /opt/vps-panel/deploy; nohup python3 build.py '"$COMMIT"' </dev/null >/dev/null 2>&1 &
echo "агент: $(vps-agent -version); сборка панели запущена в фоне"'
if [ "${WAIT:-1}" = "1" ]; then
  exec "$ROOT/deploy/wait.sh" "$KEY" "$HOST"
fi
