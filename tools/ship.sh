#!/bin/bash
# Проверки -> коммит -> GitHub. Выкладка на бой - релизом (tools/release.sh).
# Использование: tools/ship.sh <файл с сообщением коммита>
#
# Настройки - файл .ship.env в корне репозитория (в git не попадает; другой путь - SHIP_ENV),
# читается как shell:
#   GITHUB_TOKEN_FILE=<файл>  токен GitHub для git push (иначе обычные учётные данные git)
#   LEAK_PATTERNS=<файл>      строки (ERE, по одной), которым не место в репозитории и в
#                             сообщениях коммитов: проверяют tools/check.sh и этот скрипт
set -euo pipefail
cd "$(dirname "$0")/.."
msg="${1:?файл с сообщением коммита}"
env_file="${SHIP_ENV:-.ship.env}"
# shellcheck disable=SC1090
[ -f "$env_file" ] && . "$env_file"
export LEAK_PATTERNS SHIP_ENV="$env_file"

if [ -n "${LEAK_PATTERNS:-}" ] && grep -qE -f "$LEAK_PATTERNS" "$msg"; then
  echo "в сообщении коммита закрытые сведения (LEAK_PATTERNS):"
  grep -nE -f "$LEAK_PATTERNS" "$msg"
  exit 1
fi

tools/check.sh
# В коммит: изменения отслеживаемых файлов и новые файлы исходников. Случайные файлы (заметки,
# файлы в корне) не попадают - их добавляют руками.
git add -u
git ls-files --others --exclude-standard -- apps packages deploy tools |
  xargs -r -d '\n' git add --
git commit -q -F "$msg"
git log --oneline -1

# GitHub: токен читает помощник git в момент запроса - в командной строке, выводе и
# .git/config его нет. GIT_TERMINAL_PROMPT=0 - без учётных данных ошибка, а не ожидание ввода.
github=ok
token="${GITHUB_TOKEN_FILE:-}"
if [ -n "$token" ] && [ -r "$token" ]; then
  helper="!f() { if [ \"\$1\" = get ]; then echo username=x-access-token; echo \"password=\$(tr -d '[:space:]' <\"$token\")\"; fi; }; f"
  GIT_TERMINAL_PROMPT=0 git -c credential.helper= -c "credential.helper=$helper" push -q origin HEAD || github=fail
else
  GIT_TERMINAL_PROMPT=0 git push -q origin HEAD || github=fail
fi
[ "$github" = fail ] || echo "GitHub: отправлено"

if [ "$github" = fail ]; then
  echo "GitHub: коммит НЕ отправлен - отправить позже: git push"
  exit 1
fi
