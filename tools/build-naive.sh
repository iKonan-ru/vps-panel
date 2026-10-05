#!/bin/sh
# Собирает Caddy с forwardproxy (вариант naive, klzgrad/forwardproxy) для linux amd64 и arm64
# в deploy/files/naive: HTTPS-прокси для браузера.
# Версии закреплены: обновлять осознанно, проверив прокси для браузера на тестовом сервере.
set -eu
CADDY="${CADDY_VERSION:-v2.11.7}"
FWD="${FORWARDPROXY_VERSION:-v0.0.0-20250118002110-d62c80d3dd2c}"
XCADDY="${XCADDY_VERSION:-v0.4.5}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/deploy/files/naive"
GO="${GO:-$(command -v go || echo /tmp/go/bin/go)}"
[ -x "$GO" ] || { echo "build-naive: Go не найден (GO=<путь> или /tmp/go)" >&2; exit 1; }
export PATH="$(dirname "$GO"):$PATH" GOTOOLCHAIN="${GOTOOLCHAIN:-local}"
export GOPATH="${GOPATH:-/tmp/gopath}" GOCACHE="${GOCACHE:-/tmp/gocache}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
GOBIN="$TMP/bin" go install "github.com/caddyserver/xcaddy/cmd/xcaddy@$XCADDY"
mkdir -p "$OUT"
for arch in amd64 arm64; do
  (cd "$TMP" && GOOS=linux GOARCH=$arch CGO_ENABLED=0 XCADDY_SKIP_CLEANUP=0 \
    "$TMP/bin/xcaddy" build "$CADDY" \
    --with "github.com/caddyserver/forwardproxy=github.com/klzgrad/forwardproxy@$FWD" \
    --output "$OUT/caddy-linux-$arch")
done
printf 'caddy %s\nforwardproxy %s\n' "$CADDY" "$FWD" > "$OUT/VERSION"
(cd "$OUT" && sha256sum caddy-linux-amd64 caddy-linux-arm64 > SHA256SUMS)
chmod a+rX "$OUT"/*
echo "naive: caddy $CADDY + forwardproxy $FWD в $OUT"
