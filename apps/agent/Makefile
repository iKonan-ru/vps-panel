# Версия = базовая из файла VERSION + хеш содержимого исходников агента вместе с вшитыми
# go:embed файлами (*.html, ассеты baseline: правка заглушки прокси - тоже новая версия).
# Панель сравнивает строку целиком: те же исходники - та же версия, и пересборка без изменений
# не выглядит обновлением (не перезапускает агентов впустую).
# Описания (*.md) в бинарник не входят и версию не меняют.
BASE := $(shell cat VERSION)
SRC := $(shell find . -type f \( -name '*.go' -o -name go.mod -o -name go.sum -o -name '*.html' -o -path './internal/baseline/assets/*' \) ! -name '*_test.go' ! -name '*.md' ! -path '*/__pycache__/*' | LC_ALL=C sort)
HASH := $(shell cat VERSION $(SRC) | sha256sum | cut -c1-8)
VERSION ?= $(BASE)+$(HASH)
LDFLAGS := -s -w -X main.Version=$(VERSION)

.PHONY: build-all test tidy

build-all:
	CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../../dist/vps-agent-linux-amd64 ./cmd/vps-agent
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -ldflags "$(LDFLAGS)" -o ../../dist/vps-agent-linux-arm64 ./cmd/vps-agent
	gzip -9 -k -f ../../dist/vps-agent-linux-amd64 ../../dist/vps-agent-linux-arm64
	echo "$(VERSION)" > ../../dist/version.txt

test:
	go vet ./... && go test ./...

tidy:
	go mod tidy
