#!/bin/bash
# Релиз: tools/release.sh <X.Y.Z | X.Y.Z-beta.N> [update]
#
# Раздел "## <версия>" в CHANGELOG.md должен быть (его текст - описание релиза на GitHub);
# пометка "не выпущена" в заголовке меняется на сегодняшнюю дату, версия в README и
# docs/install.md (пример сводки установки " VPS Panel X установлена") - на новую. Затем
# tools/check.sh, коммит этих файлов, push main, тег v<версия>, push тега - дальше работает
# .github/workflows/release.yml (образы ghcr.io и релиз). Скрипт ждёт её и печатает итог.
# update - после релиза обновить свою панель: ssh на PANEL_HOST и "vps-panel update <версия>".
# nowait - только тег, без ожидания сборки (за ней смотреть в Actions).
# Настройки - .ship.env (как у tools/ship.sh): GITHUB_TOKEN_FILE, PANEL_HOST, PANEL_SSH_KEY,
# KNOWN_HOSTS, LEAK_PATTERNS.
set -euo pipefail
cd "$(dirname "$0")/.."
ver="${1:?версия X.Y.Z или X.Y.Z-beta.N}"
echo "$ver" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+(-beta\.[0-9]+)?$' || { echo "версия $ver: нужна X.Y.Z или X.Y.Z-beta.N"; exit 1; }
env_file="${SHIP_ENV:-.ship.env}"
# shellcheck disable=SC1090
[ -f "$env_file" ] && . "$env_file"
export KNOWN_HOSTS LEAK_PATTERNS SHIP_ENV="$env_file"
repo="iKonan-ru/vps-panel"
token="${GITHUB_TOKEN_FILE:?GITHUB_TOKEN_FILE не задан (.ship.env)}"

git rev-parse -q --verify "refs/tags/v$ver" >/dev/null && { echo "тег v$ver уже есть"; exit 1; }
grep -qE "^## $ver( |$)" CHANGELOG.md || { echo "в CHANGELOG.md нет раздела ## $ver"; exit 1; }
# файлы с версией в примере сводки установки: при релизе - на новую
docs_ver="README.md docs/install.md"
[ -z "$(git status --porcelain --untracked-files=no -- . ':!CHANGELOG.md' ':!README.md' ':!docs/install.md')" ] ||
  { echo "есть незакоммиченные правки - сначала tools/ship.sh"; exit 1; }
today="$(date +%d.%m.%Y)"
sed -i -E "s/^## $ver - не выпущена$/## $ver - $today/" CHANGELOG.md
for f in $docs_ver; do
  grep -qE '^ VPS Panel [^ ]+ установлена$' "$f" ||
    { echo "в $f нет строки ' VPS Panel <версия> установлена' (пример сводки)"; exit 1; }
  sed -i -E "s/^ VPS Panel [^ ]+ установлена$/ VPS Panel $ver установлена/" "$f"
done

tools/check.sh
helper="!f() { if [ \"\$1\" = get ]; then echo username=x-access-token; echo \"password=\$(tr -d '[:space:]' <\"$token\")\"; fi; }; f"
g() { GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c "credential.helper=$helper" "$@"; }
if [ -n "$(git status --porcelain CHANGELOG.md $docs_ver)" ]; then
  git add CHANGELOG.md $docs_ver
  git commit -q -m "Релиз $ver"
fi
g push -q origin HEAD
git tag -a "v$ver" -m "v$ver"
g push -q origin "v$ver"
echo "тег v$ver отправлен"
[ "${2:-}" = nowait ] && exit 0
echo "жду сборку релиза"

api() { curl -fsS -H "Authorization: token $(tr -d '[:space:]' <"$token")" -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$repo/$1"; }
sha="$(git rev-parse HEAD)"
for _ in $(seq 1 180); do
  sleep 20
  st="$(api "actions/runs?event=push&head_sha=$sha&per_page=10" | python3 -c '
import json, sys
runs = [r for r in json.load(sys.stdin)["workflow_runs"] if r["name"] == "release"]
r = runs[0] if runs else None
print(" ".join(str(r[k]) for k in ("status", "conclusion", "html_url")) if r else "none")')"
  case "$st" in
    "completed success"*) echo "релиз готов: https://github.com/$repo/releases/tag/v$ver"; break ;;
    completed*) echo "сборка релиза упала: ${st##* }"; exit 1 ;;
  esac
done
case "$st" in "completed success"*) ;; *) echo "сборка релиза не закончилась за час: $st"; exit 1 ;; esac

if [ "${2:-}" = update ]; then
  key="$(mktemp)"
  trap 'rm -f "$key"' EXIT
  cp "${PANEL_SSH_KEY:?PANEL_SSH_KEY не задан}" "$key"
  chmod 600 "$key"
  ssh -i "$key" -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}" \
    "${PANEL_HOST:?PANEL_HOST не задан}" "vps-panel update $ver"
fi
