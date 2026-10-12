# VPS Panel

Своя веб-панель для небольшого парка VPS с VPN-сервисами: серверы, сервисы и клиенты в одном
месте, подписки и личные страницы для людей, аудит безопасности, уведомления в Telegram.

[![Релиз](https://img.shields.io/github/v/release/iKonan-ru/vps-panel?include_prereleases&label=релиз)](https://github.com/iKonan-ru/vps-panel/releases)
[![CI](https://github.com/iKonan-ru/vps-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/iKonan-ru/vps-panel/actions/workflows/ci.yml)
[![Лицензия](https://img.shields.io/badge/лицензия-AGPL--3.0-blue)](LICENSE)

> [!WARNING]
> **Дисклеймер.** VPS Panel - личный проект для управления собственными серверами и
> предназначен только для личного использования. Он не рассчитан на производственную
> (коммерческую, промышленную) среду: там его используют на свой риск, без поддержки и
> гарантий. Запрещено использовать проект в незаконных целях и способами, нарушающими законы
> вашей страны, страны размещения серверов или правила хостинг-провайдера. Вы сами отвечаете
> за то, как применяете панель и установленные ею сервисы. Программа распространяется "как
> есть", без каких-либо гарантий; автор не несёт ответственности за любой ущерб от её
> использования (подробно - разделы 15 и 16 [лицензии](LICENSE)).

## Что это

- **Панель** ставится на один сервер в docker одной командой и обновляется из своего
  интерфейса.
- **Агент** на каждом VPS сам подключается к панели по шифрованному каналу: открывать наружу
  SSH и API сервисов не нужно.
- **Сервисы**: 3X-UI (Xray), MTProxyL, AmneziaWG, WDTT, OpenFlux и прокси для браузера -
  установка, пользователи, обновления, вход в их панели через панель.
- **Клиенты**: человек заводится один раз - панель сама создаёт его во всех сервисах на всех
  серверах и даёт ему подписку и личную страницу с конфигами и приложениями.
- **Наблюдение**: аудит безопасности с исправлением в один клик, метрики, доступность из
  России, уведомления и бэкап панели в Telegram.

Интерфейс на русском, работает и с телефона (PWA). Подробно - [возможности](docs/features.md).

## Установка

Нужен сервер с Linux (проверено на Ubuntu 24.04), root, свободные порты 80 и 443 и домен с
A-записями на этот сервер: имя панели (`panel.example.com`), имя подписок
(`sub.example.com`, по желанию) и `*.example.com` для панелей сервисов.

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/iKonan-ru/vps-panel/main/install.sh)
```

Установщик спросит домен, имя подписок и почту для Let's Encrypt, проверит DNS и порты,
поставит docker, если его нет, скачает готовые образы (amd64 и arm64) и запустит панель.
Ключи: `--beta` - канал с пре-релизами, `--version X.Y.Z` - конкретная версия, `-y` - без
вопросов (`PANEL_DOMAIN`, `ACME_EMAIL`, `SUB_DOMAIN` из окружения).

Сразу после установки:

1. Откройте панель и пройдите мастер первой настройки (администратор, пароль, 2FA) - до
   этого он открыт любому, кто первым зайдёт на адрес.
2. "Настройки" - "Бэкап панели": задайте пароль бэкапа и включите отправку в Telegram.
3. "Серверы" - "Добавить сервер": панель поставит агента по SSH или даст команду для
   ручного запуска.

Подробнее (DNS, переменные, восстановление, сеть из России) - [установка и
обслуживание](docs/install.md).

## Управление

Обновления приходят в саму панель: "Настройки" - "Версия панели" показывает новые версии со
списком изменений, ставит их кнопкой или автоматически в заданный час и возвращает прежнюю,
если новая не поднялась. Агенты на серверах обновляются за панелью сами.

На сервере панели есть команда `vps-panel`:

| Команда | Что делает |
| --- | --- |
| `vps-panel status` | версия, канал, состояние контейнеров |
| `vps-panel update [X.Y.Z]` | обновить до версии или до последней в канале |
| `vps-panel rollback` | вернуть прошлую версию |
| `vps-panel channel stable\|beta` | канал обновлений |
| `vps-panel logs [panel\|caddy]` | журналы |
| `vps-panel restart` | перезапустить панель |
| `vps-panel uninstall` | снять панель, данные остаются (`--purge` - удалить и их) |
| `vps-panel uninstall --full` | снять всё, что ставила панель на этом сервере: агент, прокси для браузера, port-sync, VPN-сервисы (с отдельным подтверждением), docker, если его ставил установщик |

## Документация

| Документ | О чём |
| --- | --- |
| [docs/install.md](docs/install.md) | установка, переменные, обновление, удаление, бэкап и восстановление, переезд со сборки из исходников |
| [docs/features.md](docs/features.md) | все возможности и сервисы на серверах |
| [docs/architecture.md](docs/architecture.md) | как устроено и как защищено |
| [docs/development.md](docs/development.md) | разработка, проверки, релизы, структура репозитория |
| [CHANGELOG.md](CHANGELOG.md) | изменения по версиям |
| [apps/agent/README.md](apps/agent/README.md) | агент: конфиг, операции, сборка, удаление |
| [apps/extension/README.md](apps/extension/README.md) | расширение Chrome и Firefox |
| [deploy/README.md](deploy/README.md) | сборка панели из исходников и тонкости Caddy, fail2ban, маршрута до Telegram |

## Благодарности

Панель управляет чужими проектами и опирается на них:

- [MHSanaei/3x-ui](https://github.com/MHSanaei/3x-ui) и [XTLS/Xray-core](https://github.com/XTLS/Xray-core)
- [Liafanx/MTProxyL](https://github.com/Liafanx/MTProxyL) и [telemt/telemt](https://github.com/telemt/telemt)
- [amnezia-vpn](https://github.com/amnezia-vpn): AmneziaWG и клиенты Amnezia
- [SpaceNeuroX/proxy-turn-vk-android](https://github.com/SpaceNeuroX/proxy-turn-vk-android) и [Regstar2/pwdtt](https://github.com/Regstar2/pwdtt): WDTT
- [p1neappleXpress/OpenFlux](https://github.com/p1neappleXpress/OpenFlux) и форк клиента для Android [damnurmum/OpenFlux-Android](https://github.com/damnurmum/OpenFlux-Android)
- [klzgrad/naiveproxy](https://github.com/klzgrad/naiveproxy) и [klzgrad/forwardproxy](https://github.com/klzgrad/forwardproxy)
- [caddyserver/caddy](https://github.com/caddyserver/caddy)
- клиент подписок [Happ](https://github.com/Happ-proxy)

## Лицензия

[GNU AGPL-3.0](LICENSE) (только версия 3). Copyright (C) 2026 Eugene Kononenko.

Кто распространяет изменённую панель или даёт людям работать с ней по сети (интерфейс,
подписки, личные страницы), обязан открыть им исходный код своей версии под той же
лицензией. Сторонние программы, которые панель ставит или несёт с собой (xray в образе,
сборки wdtt-server и Caddy с forwardproxy, проекты из "Благодарностей"), остаются под своими
лицензиями.
