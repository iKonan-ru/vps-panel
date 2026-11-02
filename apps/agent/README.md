# vps-agent

Агент VPS Panel на управляемом сервере: один статический бинарник на Go (linux amd64 и arm64)
и systemd-юнит. Агент сам подключается к панели, присылает снимки и метрики и выполняет
операции, которые панель запрашивает. Входящих портов агент не открывает.

## Что делает

- **Снимок сервера** (`inventory`): ОС и ресурсы, сервисы (3X-UI, MTProxyL, AmneziaWG, WDTT,
  OpenFlux, прокси для браузера), контейнеры docker, firewall, сертификаты, аудит
  безопасности. Раз в 5 минут, сразу после подключения и сразу, когда сервис упал или
  поднялся (проверка раз в 30 секунд).
- **Метрики**: CPU, нагрузка, память, диск, сеть - раз в 30 секунд, раз в 2 секунды, пока
  в панели открыта вкладка сервера.
- **Операции** из белого списка (ниже): аргументы проверяются, команды собираются без
  оболочки, вывод долгих операций идёт в панель потоком.
- **Терминал** (pty) и **туннель** к панелям сервисов на 127.0.0.1 - поверх того же канала.
- **Самообновление**: скачивает новую версию с панели, сверяет sha256, подменяет бинарник,
  systemd перезапускает службу.

Агент ничего не меняет на сервере сам: всё, кроме чтения, - операция по запросу панели,
которую администратор запустил и подтвердил.

## Установка

Обычно из панели: "Добавить сервер" - установка по SSH (пароль root или ключ панели) или
команда для ручного запуска. Команда выглядит так:

```bash
curl --proto '=https' -fsSL https://<панель>/agent/install.sh | sh -s -- \
  --panel https://<панель> --token <одноразовый токен> --key <ключ панели>
```

Установщик ставит только агента, docker и сервисы не трогает:

| Что | Где |
| --- | --- |
| бинарник (sha256 сверяется с панелью) | `/usr/local/bin/vps-agent` |
| конфиг, права 0600 | `/etc/vps-agent/agent.json` |
| служба (`Restart=always`, `MemoryMax=512M`) | `/etc/systemd/system/vps-agent.service` |

Токен регистрации одноразовый и живёт час. При первом подключении агент создаёт постоянный
токен сам, панель хранит только его хеш. Повторная установка заново привязывает сервер.

## Конфиг

`/etc/vps-agent/agent.json`:

| Поле | Что это |
| --- | --- |
| `panelUrl` | адрес панели, только `https://` (`http://` - лишь localhost для стенда) |
| `panelKey` | открытый ключ панели ed25519 (base64), обязателен: агент верит ему, а не домену |
| `registrationToken` | одноразовый токен регистрации; после регистрации стирается |
| `token` | постоянный токен агента |
| `serverId` | id сервера в панели, приходит при подключении |

## Запуск

Служба запускает `vps-agent` без аргументов. Флаги для ручного запуска:

| Флаг | Что делает |
| --- | --- |
| `-config <путь>` | другой конфиг (по умолчанию `/etc/vps-agent/agent.json`) |
| `-version` | напечатать версию |
| `-uninstall-plan` | состав полной очистки в JSON без изменений на сервере |
| `-uninstall` | интерактивная полная очистка с выбором ресурсов, новым паролем root и проверкой SSH |
| `-panel-root <путь>` | каталог установки панели для очистки (по умолчанию `/opt/vps-panel`) |
| `-inventory` | собрать снимок и напечатать JSON, к панели не подключаясь |
| `-naive-render` | собрать `/etc/vps-naive/Caddyfile` из config.json и users.json (вызывает команда установки прокси для браузера) |
| `-portsync-state` | напечатать JSON желаемого состояния firewall port-sync: его применяет `vps-portsync` |
| `-portsync-if-changed` | запустить `vps-portsync.service`, если в 3X-UI изменилось то, что берёт port-sync (вызывает `vps-portsync-xui.path` на каждую запись в базу 3X-UI) |

## Канал с панелью

`wss://<панель>/ws/agent?v=2`. Рукопожатие: обмен ключами X25519, панель подписывает
стенограмму ключом ed25519, агент сверяет его с `panelKey`. Токен по сети не передаётся:
агент доказывает знание его хеша HMAC-ом по стенограмме. Дальше все сообщения - двоичные
кадры AES-256-GCM. Посредник даже с настоящим сертификатом на домен панели не прочитает и не
подделает ни одного сообщения. При обрыве агент переподключается с паузой от 1 до 30 секунд.

В приветствии агент перечисляет свои операции, и панель не просит того, чего он не умеет.

## Операции

| Область | Операции |
| --- | --- |
| сервер | `inventory.get`, `metrics.interval`, `system.upgrade`, `system.reboot`, `disk.cleanup.scan`, `disk.cleanup.run` |
| безопасность | `baseline.plan`, `baseline.apply`, `firewall.enable`, `firewall.disable`, `firewall.rules.set`, `firewall.portsync.config`, `firewall.portsync.run`, `ssh.keys.list`, `ssh.keys.add`, `ssh.keys.remove`, `ssh.keys.comment` |
| docker | `docker.action`, `docker.logs` |
| резервные копии | `backup.detect`, `backup.create`, `backup.restore` |
| команды каталога | `command.run`, `command.cancel` |
| 3X-UI | `xui.info`, `xui.api`, `xui.set`, `xui.token`, `xui.service`, `xui.update` |
| MTProxyL | `mtproxyl.status`, `mtproxyl.exec` |
| AmneziaWG | `awg.status`, `awg.exec`, `awg.config` |
| WDTT | `wdtt.api` |
| OpenFlux | `openflux.status`, `openflux.exec`, `openflux.link`, `openflux.logs` |
| прокси для браузера | `naive.status`, `naive.exec` |
| терминал и туннель | `term.open`, `term.input`, `term.resize`, `term.close`, `tunnel.open`, `tunnel.write`, `tunnel.close` |
| Telegram | `telegram.send`, `telegram.updates` (запасной путь в Telegram через сервер) |
| Доступность из России | `reach.check` (измерения Globalping с адреса сервера: TCP до порта или TLS с SNI из домашних сетей РФ; у дошедших зондов - задержка, время TCP-соединения, и медиана по цели) |
| агент | `agent.update`, `agent.update.cancel` |
| полная очистка | `uninstall.scan`, `uninstall.validate`, `uninstall.prepare`, `uninstall.cancel` |

Список в коде - `cmd/vps-agent/ops*.go`; тест сверяет его с `AgentMethodSchema` в
`packages/protocol`.

## Сборка и версия

```bash
make build-all      # dist/vps-agent-linux-{amd64,arm64}, сжатые копии .gz и version.txt
make test           # go vet и go test
```

Версия - `VERSION` плюс 8 знаков хеша исходников и вшитых файлов (`0.3.2+9fce38dd`). Те же
исходники - та же версия: пересборка без изменений не выглядит обновлением. Описания (*.md)
в хеш не входят. Панель сравнивает строку целиком и показывает "есть обновление", когда
версия агента отличается от лежащей в `deploy/agent-dist`.

## Отладка

```bash
systemctl status vps-agent
journalctl -u vps-agent -f
vps-agent -version
vps-agent -inventory | less     # что агент видит на сервере
```

## Удаление

```bash
systemctl disable --now vps-agent
rm -f /usr/local/bin/vps-agent /etc/systemd/system/vps-agent.service
rm -rf /etc/vps-agent
systemctl daemon-reload
```

Сервисы, поставленные командами панели, при этом остаются на сервере.

Для полной очистки используйте меню "Очистить сервер от панели" в карточке сервера, а на
сервере панели - `vps-panel uninstall --full` по SSH. Исполнитель требует python3, systemd
и OpenSSH. Сначала новый пароль root и отдельное подключение по нему, затем выбранные
ресурсы, агент и точный ключ панели. Чужие приложения, ключи владельца и защита сохраняются.
Подробности и ограничения - [Удаление](../../docs/install.md#удаление).

`uninstall.validate` проверяет конкретный состав без смены пароля и удаления.
Режим `detachOnly` разрешает снять только агент и port-sync: нужен при отвязке соседних
серверов перед удалением панели. VPN-сервисы и Docker в этом режиме сохраняются.

`uninstall.prepare` сохраняет прежнюю конфигурацию SSH и хеш пароля в закрытом каталоге
`/run/vps-uninstall`, устанавливает новый пароль и таймер отката на 5 минут.
`uninstall.cancel` откатывает подготовку. Удаление запускается панелью по независимому SSH
через `-uninstall-run` (запрос JSON в stdin), поэтому остановка агента его не прерывает.
Эти служебные флаги не предназначены для ручного формирования запросов.

Проверки исполнителя входят в `go test ./...` (нужен python3). Дополнительный изолированный
стенд с настоящими SSH и fail2ban, сменой пароля и удалением файлов:

```bash
make build-all
docker build -t vps-panel-uninstall-ssh-test internal/uninstall/testdata/ssh
docker run --rm --network none \
  -v "$PWD/../../dist/vps-agent-linux-amd64:/test/vps-agent:ro" \
  -v "$PWD/internal/uninstall/uninstall.py:/test/uninstall.py:ro" \
  vps-panel-uninstall-ssh-test
# Повторить с -e TEST_MODE=detach: агент снимается, данные VPN остаются.
# Повторить с -e TEST_MODE=partial: журнал 3X-UI уже удалён, его настройки fail2ban остались.
```

Проверяется сохранение защиты SSH и её блокировок при удалении настроек fail2ban 3X-UI.
Стенд не подключает Docker socket и каталоги хоста для записи. В нём подменены только
systemctl и планировщик таймера: настоящее поведение systemd проверяется отдельно на VM.

## Код

| Пакет | Что внутри |
| --- | --- |
| `cmd/vps-agent` | запуск, реестр операций по областям |
| `internal/transport` | подключение к панели, шифрованный канал |
| `internal/config` | конфиг агента |
| `internal/inventory` | сборка снимка |
| `internal/metrics` | метрики и сведения о хосте |
| `internal/services` | поиск сервисов и проверка, работают ли они |
| `internal/audit` | замечания аудита безопасности |
| `internal/baseline` | эталон сервера: sshd, ufw, fail2ban, автообновления, установка port-sync (`assets/`) |
| `internal/portsync` | желаемое состояние port-sync: какие порты открыть на хосте и для контейнеров; `vps-portsync.py` только применяет его |
| `internal/lockout` | защита от самоблокировки: ключи root, пароли SSH, порты VPN, которые закроет firewall |
| `internal/firewall` | ufw, слушающие порты, DOCKER-USER |
| `internal/adapters` | 3X-UI, MTProxyL, AmneziaWG, WDTT, OpenFlux, naive, Telegram |
| `internal/command` | запуск команд каталога |
| `internal/certs` | поиск сертификатов (только чтение) |
| `internal/backup` | резервное копирование и восстановление конфигураций сервисов |
| `internal/cleanup` | чистка диска |
| `internal/uninstall` | план и полная очистка сервера; общий Python-исполнитель для API и CLI |
| `internal/selfupdate` | самообновление |
| `internal/terminal`, `internal/tunnel` | терминал и туннель к панелям сервисов |
| `internal/dockerapi`, `internal/sshd`, `internal/shell`, `internal/fsutil` | docker API, настройки sshd, запуск процессов, атомарная запись файлов |
| `internal/proto` | Go-зеркало схем `packages/protocol`, правится руками |
