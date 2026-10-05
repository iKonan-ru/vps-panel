#!/bin/sh
# Собирает wdtt-server из исходников qWDTT (SpaceNeuroX/proxy-turn-vk-android, GPL-3.0)
# для linux amd64 и arm64 и кладёт вместе с deploy.sh в deploy/files/wdtt. С правками панели:
# лимит паролей 200, admin API только на 127.0.0.1.
# Коммит закреплён: обновлять осознанно, проверяя deploy.sh на изменения.
set -eu
COMMIT="${WDTT_COMMIT:-a296c57}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deploy/files/wdtt"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
git clone -q https://github.com/SpaceNeuroX/proxy-turn-vk-android.git "$TMP/src"
cd "$TMP/src" && git checkout -q "$COMMIT"

# Правки панели. Каждая проверяется: поменялся текст в исходниках -
# сборка останавливается, а не собирает без правки.
patch_file() { # файл, что заменить, на что
  grep -qF -- "$2" "$1" || { echo "build-wdtt: в $1 нет: $2" >&2; exit 1; }
  python3 - "$1" "$2" "$3" <<'PY'
import sys
p, a, b = sys.argv[1:4]
s = open(p).read()
open(p, 'w').write(s.replace(a, b, 1))
PY
}
# лимит сгенерированных паролей: 10 -> 200 (ключи перебираются только на первом пакете соединения)
patch_file server/database_bot.go 'maxGeneratedPasswords = 10' 'maxGeneratedPasswords = 200'
# admin API только на 127.0.0.1: панель ходит к нему через агента, снаружи порт не открываем
patch_file app/src/main/assets/deploy.sh '-admin-listen 0.0.0.0:${ADMIN_PORT}' '-admin-listen 127.0.0.1:${ADMIN_PORT}'
patch_file app/src/main/assets/deploy.sh '    fw_add_input_tcp "$ADMIN_PORT"' '    : # admin API только на 127.0.0.1 (vps-panel)'
patch_file app/src/main/assets/deploy.sh 'iptables -C INPUT -p tcp --dport ${ADMIN_PORT} -m comment --comment ${IPT_COMMENT} -j ACCEPT 2>/dev/null || iptables -I INPUT -p tcp --dport ${ADMIN_PORT} -m comment --comment ${IPT_COMMENT} -j ACCEPT; ' ''

mkdir -p "$OUT"
cp app/src/main/assets/deploy.sh "$OUT/deploy.sh"
for arch in amd64 arm64; do
  CGO_ENABLED=0 GOOS=linux GOARCH=$arch go build -trimpath -ldflags "-s -w" -o "$OUT/wdtt-server-linux-$arch" ./server
done
git rev-parse HEAD > "$OUT/COMMIT"
(cd "$OUT" && sha256sum deploy.sh wdtt-server-linux-amd64 wdtt-server-linux-arm64 > SHA256SUMS)
chmod a+rX "$OUT"/*
echo "wdtt: собрано из $COMMIT в $OUT"
