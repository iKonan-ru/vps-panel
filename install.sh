#!/bin/bash
# Установка VPS Panel из релиза на GitHub:
#
#   bash <(curl -fsSL https://raw.githubusercontent.com/iKonan-ru/vps-panel/main/install.sh)
#
# Скачивает команду vps-panel из релиза и запускает "vps-panel install" с теми же ключами:
#   -y              без вопросов (PANEL_DOMAIN, ACME_EMAIL, SUB_DOMAIN - из окружения)
#   --beta          канал "бета": пре-релизы тоже
#   --version X.Y.Z конкретная версия
set -euo pipefail
REPO="iKonan-ru/vps-panel"
[ "$(id -u)" = 0 ] || { echo "запускать от root: sudo bash <(curl -fsSL ...)" >&2; exit 1; }
command -v curl >/dev/null || { apt-get update -qq && apt-get install -y -qq curl >/dev/null; }

ver=""
beta=0
prev=""
for a in "$@"; do
  [ "$prev" = "--version" ] && ver="$a"
  [ "$a" = "--beta" ] && beta=1
  prev="$a"
done
if [ -z "$ver" ]; then
  # последний релиз (с --beta - и пре-релиз; GitHub отдаёт их от новых к старым)
  if [ "$beta" = 1 ]; then
    tag="$(curl -fsSL -m 30 "https://api.github.com/repos/$REPO/releases?per_page=1" | grep -m1 '"tag_name"' | cut -d'"' -f4)"
  else
    tag="$(curl -fsSL -m 30 "https://api.github.com/repos/$REPO/releases/latest" | grep -m1 '"tag_name"' | cut -d'"' -f4 || true)"
  fi
  [ -n "${tag:-}" ] || { echo "не удалось узнать последний релиз на GitHub (api.github.com); стабильного релиза ещё нет - запустите с --beta" >&2; exit 1; }
  ver="${tag#v}"
fi
tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT
curl -fsSL -m 60 --retry 3 "https://github.com/$REPO/releases/download/v$ver/vps-panel" -o "$tmp" || { echo "не скачалась команда vps-panel релиза v$ver" >&2; exit 1; }
install -m 755 "$tmp" /usr/local/bin/vps-panel
args=("$@")
printf '%s\n' "${args[@]}" | grep -qx -- '--version' || args+=(--version "$ver")
exec /usr/local/bin/vps-panel install "${args[@]}"
