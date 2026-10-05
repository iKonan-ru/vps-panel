#!/bin/sh
# Ждёт окончания фоновой сборки панели (см. push.sh), печатая ход при каждой смене шага:
# "[02:31] шаг 4/10: установка зависимостей". Тот же ход панель показывает полосой сверху.
# Использование: deploy/wait.sh <ssh-ключ> [user@host] (иначе PANEL_HOST)
set -eu
KEY="${1:?путь к ssh-ключу}"
HOST="${2:-${PANEL_HOST:?сервер панели: второй аргумент user@host или PANEL_HOST}}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# ключи хоста сервера панели - KNOWN_HOSTS=<файл> (иначе ~/.ssh/known_hosts); проверка строгая
SSH="ssh -i $KEY -o ConnectTimeout=15 -o StrictHostKeyChecking=yes -o UserKnownHostsFile=${KNOWN_HOSTS:-$HOME/.ssh/known_hosts}"
STATUS=/opt/vps-panel/deploy/data/deploy.json
last=""
i=0
sleep 3 # build.py только что запущен: даём ему записать свой отчёт вместо прошлого
while [ $i -lt 180 ]; do
  line=$($SSH "$HOST" "python3 -c 'import json,time;d=json.load(open(\"$STATUS\"));e=int(time.time())-d[\"startedAt\"];print(d[\"state\"],\"[%02d:%02d] шаг %s/%s: %s\"%(e//60,e%60,d[\"step\"],d[\"total\"],d[\"stepName\"]))'" 2>/dev/null || echo "wait нет отчёта о сборке")
  state=${line%% *}
  text=${line#* }
  step=${text#*] }
  if [ "$step" != "$last" ]; then
    echo "$text"
    last=$step
  fi
  case "$state" in
    done)
      $SSH "$HOST" 'cd /opt/vps-panel/deploy && docker compose ps --format "{{.Name}} {{.Status}}" | grep panel-1'
      exit 0 ;;
    failed)
      echo "СБОРКА УПАЛА, работает прежняя версия. Хвост лога:"
      $SSH "$HOST" "python3 -c 'import json;print(chr(10).join(json.load(open(\"$STATUS\")).get(\"tail\",[])))'"
      exit 1 ;;
  esac
  i=$((i + 1))
  sleep 5
done
echo "сборка не завершилась за 15 минут, смотри /tmp/panel-build.log на сервере"
exit 1
