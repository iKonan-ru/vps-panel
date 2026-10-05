#!/bin/bash
# Проверки -> коммит -> GitHub -> выкладка на бой. Сбой проверок, коммита или выкладки
# останавливает всё; сбой отправки на GitHub выкладку не держит, о нём - в конце (код 1).
# Использование: tools/ship.sh <файл с сообщением коммита> [nodeploy]
#
# Настройки - файл .ship.env в корне репозитория (в git и на сервер не попадает; другой путь -
# SHIP_ENV), читается как shell:
#   PANEL_HOST=root@<адрес>   сервер панели (для выкладки обязательно)
#   PANEL_DOMAIN=<домен>      домен панели: проверка /api/health (для выкладки обязательно)
#   SUB_DOMAIN=<имя>          имя подписок для проверки после выкладки (пусто - не проверять)
#   PANEL_SSH_KEY=<файл>      ключ ssh к серверу панели (копируется во временный файл 0600)
#   KNOWN_HOSTS=<файл>        ключи хоста сервера панели (иначе ~/.ssh/known_hosts)
#   GITHUB_TOKEN_FILE=<файл>  токен GitHub для git push (иначе обычные учётные данные git)
#   LEAK_PATTERNS=<файл>      строки (ERE, по одной), которым не место в репозитории и в
#                             сообщениях коммитов: проверяют tools/check.sh и этот скрипт
set -euo pipefail
cd "$(dirname "$0")/.."
msg="${1:?файл с сообщением коммита}"
env_file="${SHIP_ENV:-.ship.env}"
# shellcheck disable=SC1090
[ -f "$env_file" ] && . "$env_file"
export KNOWN_HOSTS LEAK_PATTERNS SHIP_ENV="$env_file"

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

if [ "${2:-}" != "nodeploy" ]; then
  host="${PANEL_HOST:?PANEL_HOST не задан (.ship.env)}"
  domain="${PANEL_DOMAIN:?PANEL_DOMAIN не задан (.ship.env)}"
  key="$(mktemp)"
  trap 'rm -f "$key"' EXIT
  cp "${PANEL_SSH_KEY:?PANEL_SSH_KEY не задан (.ship.env)}" "$key"
  chmod 600 "$key"
  WAIT=0 bash deploy/push.sh "$key" "$host" | tail -2
  bash deploy/wait.sh "$key" "$host" | tail -2
  sleep 15
  curl -s -m 15 "https://$domain/api/health"
  echo
  # подписки и личные страницы на SUB_DOMAIN: TLS жив и отвечает сама панель (зелёный
  # /api/health этого не гарантирует - имя подписок может отдавать ошибку TLS)
  subdomain="${SUB_DOMAIN:-}"
  if [ -n "$subdomain" ]; then
    sub="$(curl -s -m 15 -w '|%{http_code}' "https://$subdomain/c/00000000000000000000000000000000" || true)"
    case "$sub" in
      *'|404') case "$sub" in *'Панель не найдена'*) echo "$subdomain: ответ прокси поддоменов, а не панели"; exit 1;; *) echo "$subdomain: ок";; esac ;;
      *) echo "$subdomain НЕ ОТВЕЧАЕТ (${sub##*|}): подписки и личные страницы клиентов недоступны"; exit 1 ;;
    esac
  fi
fi

if [ "$github" = fail ]; then
  echo "GitHub: коммит НЕ отправлен - отправить позже: git push"
  exit 1
fi
