# Разработка

Нужны Node.js 22+, pnpm (через corepack) и Go 1.26+ (агент; сборка Caddy naive).

```bash
corepack pnpm install
corepack pnpm dev                                   # сервер и интерфейс в режиме разработки
corepack pnpm --filter @vps/protocol build          # после правок протокола
corepack pnpm -r --filter @vps/protocol --filter @vps/server --filter @vps/web exec tsc --noEmit
npx biome check --write apps/web/src apps/server/src apps/server/test packages/protocol/src
cd apps/server && npx vitest run
cd apps/agent && go vet ./... && go test ./... && make build-all
```

Перед коммитом - `tools/check.sh`: протокол, типы, biome, тесты сервера, агент (gofmt,
vet, test, govulncheck), `pnpm audit`, только клавиатурные символы в файлах. То же на
GitHub - `.github/workflows/ci.yml` на каждый push и pull request.

Релиз: раздел `## X.Y.Z` в `CHANGELOG.md` и `tools/release.sh X.Y.Z` (предварительная версия -
`X.Y.Z-beta.N`) - тег, сборка образов и релиза в GitHub Actions (`release.yml`, около 15 минут).

Правила проекта: код, комментарии, интерфейс и документы - на русском; в файлах только
символы с клавиатуры. В документах и консоли - дефис вместо тире и прямые кавычки;
типографские знаки интерфейса - сущностями в JSX (`&laquo;`, `&mdash;`, `&nbsp;`) и кодами в
строках TS (`\u00ab`, `\u2014`, `\u00a0`).

## Тексты интерфейса

- Обращение безличное, "вы" со строчной - только где без него нельзя. Кнопка - инфинитив
  ("Сохранить"), переключатель - название того, что он включает ("Автоматическое обновление
  панели"), заголовок - существительное.
- Коротко и конкретно: без пояснений очевидного, подсказка - до двух фраз.
- Термины: синхронизация (клиентов), резервная копия, предварительный канал и предварительная
  версия, сервер в сети / не в сети, inbound (без склонения).
- Время - местное время браузера. Ошибки API - со строчной, без точки.
- Типографика интерфейса: ёлочки, тире с неразрывным пробелом, многоточие одним знаком,
  неразрывный пробел между числом и единицей (запись в исходниках - выше). Проверяет
  `tools/check-typography.mjs`, часть `tools/check.sh`.

## Структура репозитория

```
apps/
  server/       панель: Fastify, база, маршруты API, каталог команд, синхронизация клиентов
  web/          интерфейс: React, свой UI-кит в components/ui
  agent/        агент на Go: cmd/vps-agent, internal/* (снимок, аудит, сервисы, терминал...)
  extension/    расширение Chrome и Firefox для прокси для браузера
packages/
  protocol/     zod-схемы протокола агент-панель и общие типы
deploy/         Dockerfile, Caddyfile, fail2ban; release/ - vps-panel и compose.yml релизов;
                install.sh и docker-compose.yml - сборка из исходников
install.sh      установка из релиза одной командой
.github/        CI и сборка релизов (образы ghcr.io)
tools/          check.sh, ship.sh, сборка wdtt-server и Caddy с forwardproxy, подпись расширения Firefox
```

## Документы подпроектов

| Документ | О чём |
| --- | --- |
| `apps/agent/README.md` | агент: установка, конфиг, флаги, канал, операции, сборка, отладка, удаление |
| `apps/extension/README.md` | расширение Chrome и Firefox: файлы, установка, подпись, обновление |
| `deploy/README.md` | сборка панели из исходников: Caddy, fail2ban, маршрут до Telegram, файлы команд |
