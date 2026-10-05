FROM node:22-alpine AS build
RUN corepack enable && corepack prepare pnpm@10.34.5 --activate
WORKDIR /src
# системные пакеты - до package.json: смена зависимостей не пересобирает этот слой
RUN apk add --no-cache python3 make g++
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
# хранилище pnpm - в кэше сборки: при смене зависимостей качаются только новые пакеты, а не все
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm install --frozen-lockfile --store-dir /pnpm-store
COPY packages packages
COPY apps/server apps/server
COPY apps/web apps/web
RUN pnpm --filter @vps/protocol build && pnpm --filter @vps/web build && pnpm --filter @vps/server build
RUN --mount=type=cache,id=pnpm-store,target=/pnpm-store pnpm --filter @vps/server --prod --legacy deploy /out/server --store-dir /pnpm-store

# xray-клиент для выхода панели в Telegram (запускается панелью как дочерний процесс, lib/xray.ts)
FROM alpine:3 AS xray
ARG XRAY_VERSION=v26.3.27
# sha256 архивов этой версии (SHA2-256 из .dgst релиза): xray живёт в образе рядом с секретами,
# скачанное проверяется; при смене версии - обновить
ARG XRAY_SHA256_AMD64=23cd9af937744d97776ee35ecad4972cf4b2109d1e0fe6be9930467608f7c8ae
ARG XRAY_SHA256_ARM64=4d30283ae614e3057f730f67cd088a42be6fdf91f8639d82cb69e48cde80413c
ARG TARGETARCH
RUN apk add --no-cache curl unzip && \
    case "$TARGETARCH" in arm64) A=arm64-v8a H=$XRAY_SHA256_ARM64 ;; *) A=64 H=$XRAY_SHA256_AMD64 ;; esac && \
    curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${A}.zip" -o /tmp/xray.zip && \
    echo "$H  /tmp/xray.zip" | sha256sum -c - && \
    unzip -q /tmp/xray.zip xray -d /out && chmod 755 /out/xray

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=xray /out/xray /usr/local/bin/xray
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web
# расширение Chrome: архив с личной страницы клиента собирает панель
COPY apps/extension /app/extension
ENV EXTENSION_DIR=/app/extension
# Файлы могут прийти с правами 0600, а процесс работает от node.
RUN chmod -R a+rX /app
USER node
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
