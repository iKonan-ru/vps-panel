# Сборка панели из исходников

Обычная установка и обновления - из релизов, см. [docs/install.md](../docs/install.md). Здесь -
сборка из исходников (для разработки и своих правок) и тонкости, общие для обоих способов:
Caddy, fail2ban, маршрут до Telegram, файлы для команд.

Сервер: Ubuntu 24.04, docker + compose plugin. Панель из исходников живёт в /opt/vps-panel,
данные (SQLite, ключ SSH панели) - в /opt/vps-panel/deploy/data. Переезд такой установки на
релизы - `vps-panel migrate` (docs/install.md).

## Установка

Скрипт `deploy/install.sh` на сервере после `git clone` в /opt/vps-panel. Он интерактивный:
спрашивает домен панели, имя подписок и почту для Let's Encrypt, проверяет DNS и
порты, при необходимости ставит docker, пишет `deploy/.env` с `SESSION_SECRET`,
собирает агента, настраивает ufw и fail2ban для входа в панель, запускает панель и
проверяет `/api/health`. Повторный запуск - обновление.

Администратора со случайным паролем создаёт скрипт в конце (логин и пароль - в его выводе);
при запуске руками - `docker compose exec panel node server/dist/cli.js admin-init [логин]`.
Там же сброс: `admin-password`, `admin-2fa`. Мастера в браузере нет, 2FA настраивается при
первом входе.

## Боевой режим (HTTPS через Caddy)

Панель - на домене панели (`PANEL_DOMAIN`, например panel.example.com), подписки и
личные страницы - на имени подписок (`SUB_DOMAIN`, например sub.example.com). Смена
`.env` без смены `Caddyfile`
выкладкой не применяется - пересоздать caddy и panel руками
(`docker compose up -d --force-recreate caddy panel`).

Установка вручную:

    cd /opt/vps-panel/deploy
    cp .env.example .env            # PANEL_DOMAIN, ACME_EMAIL, SESSION_SECRET (openssl rand -base64 48), SUB_DOMAIN (имя для подписок, можно пусто)
    mkdir -p data && chown 1000:1000 data
    chmod -R a+rX agent-dist         # бинарники агента из dist/ после make build-all
    docker compose up -d --build

Caddy сам получает сертификат Let's Encrypt, HTTP перенаправляет на HTTPS.
Снаружи должны быть открыты 80/tcp, 443/tcp и 443/udp (HTTP/3); port-sync
открывает их сам, потому что Caddy публикует эти порты в docker. На
SUB_DOMAIN (своя A-запись) Caddy отдаёт только /sub/* и /c/* - подписки и
личные страницы клиентов, остальное - 404; на имени панели /sub/* и /c/*,
наоборот, 404 (если SUB_DOMAIN задан). Журналы Caddy - access.log и
access-sub.log в томе deploy_caddy_data, токены из адресов в них не пишутся.
Пока панель перезапускается при выкладке (около 5 с), Caddy держит запросы и
повторяет попытку до 30 с (`lb_try_duration`), а не отдаёт 502.

Контейнеры урезаны: `cap_drop: [ALL]`, `no-new-privileges`,
корень только для чтения; panel пишет только в `/data` и `/tmp` (tmpfs),
caddy - в свои тома и `/tmp`, из привилегий у него только порты 80 и 443.

fail2ban для входа в панель (неудачные логин и код 2FA по логу Caddy; `install.sh`
настраивает его сам):

    cp fail2ban-panel.conf /etc/fail2ban/filter.d/vps-panel.conf
    cp fail2ban-panel.jail /etc/fail2ban/jail.d/vps-panel.conf
    # restart, не reload: fail2ban 1.0 при перезагрузке jail новое действие (banaction) не ставит
    systemctl restart fail2ban
    # проверка: строки с неудачным входом находятся и с датой ("ts":{EPOCH} в Date template hits)
    fail2ban-regex /var/lib/docker/volumes/deploy_caddy_data/_data/access.log vps-panel
    # бан ставится в DOCKER-USER (порты Caddy в docker идут через FORWARD, не через INPUT)
    iptables -S DOCKER-USER | grep f2b

## Тестовый режим (без HTTPS, только localhost)

    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d --build panel
    # смотреть через ssh -L 3000:127.0.0.1:3000 root@<сервер>

## Обновление

Повторный запуск `deploy/install.sh`. Вручную - rsync репозитория (без node_modules,
dist, deploy/data, deploy/.env) и

    docker compose up -d --build panel

Новые бинарники агента - в deploy/agent-dist (chmod a+rX) вместе с
version.txt из dist/ (make build-all в apps/agent). Версия агента =
apps/agent/VERSION + "+" + хеш содержимого исходников агента (Makefile): те же
исходники - та же версия, пересборка без правок обновлением не выглядит, от
коммита версия не зависит. Панель сравнивает её с тем, что прислал агент, и
показывает "есть обновление". Обновление - кнопкой "Обновить агента" в
карточке или всех по очереди - плашкой "обновить агентов (N)" на странице
серверов (первая ошибка останавливает раскатку).

## AmneziaWG

Управление AWG - во вкладке AWG карточки сервера.

## Маршрут до Telegram (сервер панели в РФ)

С хоста панели в РФ api.telegram.org недоступен. В образ панели положен бинарник
xray (стадия xray в Dockerfile, версия - ARG XRAY_VERSION); панель запускает
его как дочерний процесс с конфигом в data/xray/config.json и HTTP-прокси
127.0.0.1:3128 внутри контейнера. Настраивается в панели: Настройки -> Выход
в Telegram: выбрать сервер с 3x-ui и VLESS-Reality инбаунд, панель через
агента заводит в 3x-ui клиента vps-panel и собирает конфиг сама. Порядок
путей доставки: xray - напрямую - через агент любого сервера. TG_PROXY_URL в
compose - необязательный внешний прокси, он используется, когда встроенный
xray не запущен. Через тот же xray идут запросы к GitHub и ghcr.io (релизы
клиентских приложений, веб-панели и движка MTProxyL): сначала напрямую, при
сетевой ошибке - через него.

## Файлы для команд

deploy/files раздаётся панелью по /files/<путь> (без входа, как бинарники
агента; контрольная сумма - /files/sha256/<путь>) и монтируется в контейнер.
Сейчас там WDTT: deploy.sh и бинарники wdtt-server, собранные из исходников
qWDTT скриптом tools/build-wdtt.sh (нужен Go), и naive: Caddy с forwardproxy для
прокси для браузера, скрипт tools/build-naive.sh, и firefox: подписанное Mozilla
расширение для Firefox и updates.json (tools/sign-firefox.mjs, нужен ключ API
addons.mozilla.org; клиентам - по /sub/firefox/<файл> и /c/<токен>/firefox.xpi). В git из
deploy/files ничего не хранится: deploy/install.sh собирает файлы сам (и пересобирает,
когда меняется скрипт сборки), при выкладке с машины разработки - собрать там, push.sh
переносит deploy/files вместе с кодом.

## Резервная копия

Настройки - блок "Резервная копия панели": пароль копии (хранить отдельно), ежедневная
отправка файлом в Telegram, кнопки "Отправить в Telegram" и "Скачать". В архиве
снимок panel.db (VACUUM INTO, проверен integrity_check), panel.env с
SESSION_SECRET (ключ к зашифрованному в базе: доступы, ключи клиентов AWG,
токены 3X-UI), panel_ssh_ed25519 (ключ, которым панель заходит на серверы),
panel_agent_ed25519.pem (ключ, которому верят агенты: без него восстановленной
панели не поверит ни один агент 0.3.0+), xray/config.json и README.txt. Резервные копии серверов (data/backups) не входят.

Восстановление:

```bash
openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000 -in vps-panel-backup-<дата>.tar.gz.enc | tar xz
cd /opt/vps-panel/deploy && docker compose stop panel
cp vps-panel-backup/panel.db vps-panel-backup/panel_ssh_ed25519* vps-panel-backup/panel_agent_ed25519.pem data/
chmod 600 data/panel_ssh_ed25519 data/panel_agent_ed25519.pem
mkdir -p data/xray && cp vps-panel-backup/xray/config.json data/xray/
rm -f data/panel.db-wal data/panel.db-shm && chown -R 1000:1000 data
# SESSION_SECRET из vps-panel-backup/panel.env - в .env (без него зашифрованное не прочитать)
docker compose up -d panel
```

Вручную без панели: `sqlite3 panel.db ".backup /path/panel-backup.db"` (WAL -
только так или остановив панель) плюс panel_ssh_ed25519, panel_agent_ed25519.pem и
SESSION_SECRET из .env.

## Выкладка исходников

Только для установки из исходников: `tools/ship.sh <файл с сообщением> deploy` с машины
разработки - проверки, коммит, отправка на GitHub, push.sh и wait.sh (на сервер с установкой
из релиза push.sh не выкладывает). Настройки - файл
`.ship.env` в корне репозитория (в git и на сервер не попадает; другой путь -
`SHIP_ENV`): `PANEL_HOST`, `PANEL_DOMAIN`, `SUB_DOMAIN`, `PANEL_SSH_KEY`,
`KNOWN_HOSTS`, `GITHUB_TOKEN_FILE`, `LEAK_PATTERNS` (шапка `tools/ship.sh`).

`deploy/push.sh <ssh-ключ> [user@host]` (без второго аргумента - `PANEL_HOST`) - rsync
кода и dist/ с правильными правами (контейнер panel работает от uid 1000; `.ship.env`
не копируется),
обновление агента на сервере панели, пересоздание caddy при изменённом
Caddyfile (после `caddy validate`) и пересборка panel в фоне через
`deploy/build.py` (лог /tmp/panel-build.log, ход - в data/deploy.json: его
показывает панель полосой сверху; после сборки - чистка кэша сборки старше
суток, кроме хранилища pnpm); изменённые настройки caddy в
`docker-compose.yml` применяются тут же (`up -d --no-deps caddy`); `deploy/wait.sh <ключ> [user@host]` печатает ход по
шагам и итог (push.sh зовёт его сам, WAIT=0 - не ждать). Оба проверяют
сервер по ключам из `KNOWN_HOSTS` или `~/.ssh/known_hosts`
(`StrictHostKeyChecking=yes`); после переустановки сервера панели - обновить
ключи (`ssh-keyscan -t ed25519,ecdsa,rsa <ip>`, сверить с
`/etc/ssh/ssh_host_*_key.pub` на сервере).
ssh-keyscan - не чаще раза в час: несколько подключений без входа fail2ban
сервера считает перебором и банит адрес по ssh на час.

Если Docker Hub с сервера панели недоступен (так бывает с серверов в РФ): базовые
образы node:22-alpine
и alpine:3 должны лежать в локальном хранилище образов, иначе сборка падает
на TLS handshake timeout. Если их нет (после docker image prune -a),
перелить с сервера, откуда Docker Hub доступен: ssh <foreign> "docker pull node:22-alpine;
docker pull alpine:3; docker save node:22-alpine alpine:3" | docker load.
Очистка мусора из панели их не трогает: образы node и alpine исключены из
категории "неиспользуемые образы".
