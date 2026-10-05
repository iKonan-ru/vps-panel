#!/usr/bin/env python3
"""Сборка панели на сервере с отчётом о ходе (запускает push.sh в фоне).

Запускает `docker compose up -d --build panel`, лог - в /tmp/panel-build.log, а ход (этап,
шаг, время, итог) - в data/deploy.json: его показывает сама панель полосой сверху, а
wait.sh печатает в терминал. Пока идёт сборка, работает старая версия панели.
Использование: build.py <коммит>
"""
import json
import os
import re
import subprocess
import sys
import time

DEPLOY = os.path.dirname(os.path.abspath(__file__))
STATUS = os.path.join(DEPLOY, 'data', 'deploy.json')
LOG = '/tmp/panel-build.log'
COMMIT = sys.argv[1] if len(sys.argv) > 1 else '?'

# шаги Dockerfile по порядку: номер в стадии build -> понятное название
STEPS = [
    ('load build definition', 'подготовка'),
    ('corepack', 'pnpm'),
    ('apk add', 'системные пакеты'),
    ('pnpm install', 'установка зависимостей'),
    ('COPY packages', 'копирование кода'),
    ('pnpm --filter @vps/protocol build', 'сборка протокола, интерфейса и сервера'),
    ('deploy /out/server', 'сборка серверного пакета'),
    ('chmod -R a+rX /app', 'итоговый образ'),
    ('exporting', 'сохранение образа'),
    ('Recreate', 'перезапуск панели'),
]
STEP_RE = re.compile(r'^#\d+ \[[^\]]+\] (.*)$')
started = time.time()


def previous_version():
    """Версия, которая работает, пока идёт сборка: коммит прошлой удачной выкладки."""
    try:
        old = json.load(open(STATUS))
    except (OSError, ValueError):
        return None
    return old.get('commit') if old.get('state') == 'done' else old.get('running')


RUNNING = previous_version()


def write(state, step=0, name='', tail=None):
    data = {
        'state': state,
        'commit': COMMIT,
        'startedAt': int(started),
        'updatedAt': int(time.time()),
        'step': step,
        'total': len(STEPS),
        'stepName': name,
        # что работает сейчас: до конца сборки - прошлая версия, после - эта
        'running': COMMIT if state == 'done' else RUNNING,
    }
    if tail is not None:
        data['tail'] = tail
    tmp = STATUS + '.tmp'
    with open(tmp, 'w') as f:
        json.dump(data, f, ensure_ascii=False)
    os.chmod(tmp, 0o644)
    os.replace(tmp, STATUS)


def progress():
    """Самый дальний шаг, до которого дошёл лог."""
    try:
        text = open(LOG, encoding='utf-8', errors='replace').read()
    except OSError:
        return 0, ''
    best = 0
    for line in text.splitlines():
        m = STEP_RE.match(line)
        body = m.group(1) if m else line
        for i, (marker, _) in enumerate(STEPS, 1):
            if marker in body and i > best:
                best = i
    return best, STEPS[best - 1][1] if best else 'подготовка'


def main():
    write('building', 0, 'подготовка')
    with open(LOG, 'w') as log:
        proc = subprocess.Popen(['docker', 'compose', 'up', '-d', '--build', 'panel'],
                                cwd=DEPLOY, stdout=log, stderr=subprocess.STDOUT)
        while proc.poll() is None:
            write('building', *progress())
            time.sleep(2)
    code = proc.returncode
    with open(LOG, 'a') as log:
        log.write(f'EXIT={code}\n')
    if code == 0:
        write('done', len(STEPS), 'готово')
    else:
        lines = open(LOG, encoding='utf-8', errors='replace').read().splitlines()
        write('failed', *progress(), [l for l in lines if l.strip()][-25:])  # шаг, на котором упало
    # Кэш сборки старше суток - в мусор, кроме кэш-монтирований (хранилище pnpm: без него
    # установка зависимостей идёт с нуля). --keep-storage в docker 29 не чистит ничего:
    # кэш рос на ~650 МБ за выкладку и за неделю доходил до 18 ГБ.
    subprocess.run(['docker', 'builder', 'prune', '-af', '--filter', 'until=24h',
                    '--filter', 'type!=exec.cachemount'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


if __name__ == '__main__':
    main()
