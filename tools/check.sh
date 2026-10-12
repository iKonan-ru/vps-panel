#!/bin/bash
# Проверки перед коммитом и выкладкой: протокол, типы трёх пакетов, biome, тесты сервера,
# агент (если менялся: gofmt, go vet, go test), типографика интерфейса, только клавиатурные
# символы в своих файлах.
# Любой сбой - выход с ошибкой. Использование: tools/check.sh (CHECK_AGENT=1 - агент всегда).
set -euo pipefail
cd "$(dirname "$0")/.."

corepack pnpm --filter @vps/protocol build >/dev/null
corepack pnpm -r --filter @vps/protocol --filter @vps/server --filter @vps/web exec tsc --noEmit
npx biome check apps/web/src apps/server/src apps/server/test packages/protocol/src >/dev/null
# типографика текстов интерфейса: ёлочки, тире, многоточие (свод правил - docs/development.md)
node tools/check-typography.mjs apps/web/src
log="$(mktemp)"
(cd apps/server && npx vitest run >"$log" 2>&1) || { grep -P "FAIL|\x{00D7}" "$log" | head; rm -f "$log"; exit 1; }
grep -E "Tests " "$log"
rm -f "$log"

# Известные уязвимости зависимостей: предупреждение, не падение - обновление
# пакетов - отдельная правка. Без сети pnpm audit тоже ответит ошибкой - это видно по тексту.
if audit="$(corepack pnpm audit --prod 2>&1)"; then
  echo "pnpm audit: известных уязвимостей нет"
else
  echo "ВНИМАНИЕ, pnpm audit:"
  echo "$audit" | tail -3
fi

# Go в системе может не быть (его кладут в /tmp/go): нужен, только когда менялся агент
if [ -n "$(git status --porcelain apps/agent)" ] || [ "${CHECK_AGENT:-}" = 1 ]; then
  GO="${GO:-$(command -v go || echo /tmp/go/bin/go)}"
  [ -x "$GO" ] || { echo "Go не найден: укажи GO=<путь к go> или положи его в /tmp/go"; exit 1; }
  export GOTOOLCHAIN=local GOPATH="${GOPATH:-/tmp/gopath}" GOCACHE="${GOCACHE:-/tmp/gocache}"
  bad="$(cd apps/agent && "$(dirname "$GO")/gofmt" -l .)"
  [ -z "$bad" ] || { echo "gofmt: $bad"; exit 1; }
  (cd apps/agent && "$GO" vet ./... && "$GO" test ./... >/dev/null)
  echo "агент: gofmt, vet, test - ок"
  # уязвимости Go: стандартная библиотека - той версии Go, которой собирается агент;
  # предупреждение, не падение. Нет govulncheck: go install golang.org/x/vuln/cmd/govulncheck@latest
  VC="$(command -v govulncheck || echo "$GOPATH/bin/govulncheck")"
  if [ -x "$VC" ]; then
    if vuln="$(cd apps/agent && PATH="$(dirname "$GO"):$PATH" "$VC" ./... 2>&1)"; then
      echo "govulncheck: уязвимостей нет"
    else
      echo "ВНИМАНИЕ, govulncheck:"
      echo "$vuln" | grep -E "^Vulnerability|Fixed in|Your code" | head -20
    fi
  else
    echo "govulncheck не установлен - проверка уязвимостей агента пропущена"
  fi
fi

# расширение Chrome менялось - его версия в manifest.json должна вырасти: по ней расширения у
# клиентов узнают об обновлении
if [ -n "$( (git diff --name-only HEAD -- apps/extension; git ls-files --others --exclude-standard apps/extension) | grep -v -E '/README\.md$' || true)" ] &&
  ! git diff HEAD -- apps/extension/manifest.json | grep -qE '^\+[[:space:]]*"version"'; then
  echo "apps/extension изменён, а версия в apps/extension/manifest.json - нет: подними version"
  exit 1
fi

# закрытые сведения своей установки (адреса, домены, хостинги): строки из файла
# LEAK_PATTERNS (задаётся в .ship.env, см. tools/ship.sh) - ни в одном файле репозитория
if [ -z "${LEAK_PATTERNS:-}" ] && [ -f "${SHIP_ENV:-.ship.env}" ]; then
  # shellcheck disable=SC1090
  . "${SHIP_ENV:-.ship.env}"
fi
if [ -n "${LEAK_PATTERNS:-}" ]; then
  [ -r "$LEAK_PATTERNS" ] || { echo "нет файла LEAK_PATTERNS: $LEAK_PATTERNS"; exit 1; }
  leak="$( (git ls-files; git ls-files --others --exclude-standard) | sort -u |
    while read -r f; do [ -f "$f" ] && echo "$f"; done | xargs -r -d '\n' grep -IlE -f "$LEAK_PATTERNS" || true)"
  [ -z "$leak" ] || { echo "закрытые сведения (LEAK_PATTERNS) в файлах: $leak"; exit 1; }
fi

# в своих файлах только клавиатурные символы (deploy/files - чужие файлы)
changed="$( (git diff --name-only HEAD; git ls-files --others --exclude-standard) | sort -u |
  grep -v -E '^deploy/files/' | while read -r f; do [ -f "$f" ] && echo "$f"; done || true)"
if [ -n "$changed" ]; then
  # -I: двоичные файлы (шрифты, картинки) не проверяются
  bad="$(echo "$changed" | xargs -r -d '\n' grep -IlP "[^\x00-\x7F\p{Cyrillic}]" || true)"
  [ -z "$bad" ] || { echo "неклавиатурные символы: $bad"; exit 1; }
fi
