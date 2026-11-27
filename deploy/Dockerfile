FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS build
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

# xray-клиент для выхода панели в Telegram (запускается панелью как дочерний процесс)
FROM alpine:3@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS xray
ARG XRAY_VERSION=v26.11.9
# sha256 архивов этой версии (SHA2-256 из .dgst релиза): xray живёт в образе рядом с секретами,
# скачанное проверяется; при смене версии - обновить
ARG XRAY_SHA256_AMD64=b651f7e1d9966ee2c1b1ee1bf8b52c72771824d3065dce96bbc8bcc19ed95f82
ARG XRAY_SHA256_ARM64=64ed6858982a7f5eb85d88b811089063bd4f17561f4c8f44e0f1dc8e6f6430be
ARG TARGETARCH
RUN apk add --no-cache curl unzip && \
    case "$TARGETARCH" in arm64) A=arm64-v8a H=$XRAY_SHA256_ARM64 ;; *) A=64 H=$XRAY_SHA256_AMD64 ;; esac && \
    curl -fsSL "https://github.com/XTLS/Xray-core/releases/download/${XRAY_VERSION}/Xray-linux-${A}.zip" -o /tmp/xray.zip && \
    echo "$H  /tmp/xray.zip" | sha256sum -c - && \
    unzip -q /tmp/xray.zip xray -d /out && chmod 755 /out/xray

# Агент (vps-agent-linux-*) и сборки naive и wdtt для раздачи серверам: релиз (release.yml)
# подставляет их вместо этой стадии (--build-context artifacts=<каталог>).
FROM alpine:3@sha256:f59abe656b692d901e184be3445e084786602108599d2a51d229c0f5a48c71bf AS artifacts
RUN mkdir -p /agent-dist /files

FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5
# версия релиза (тег без v) и коммит: их показывает панель и по ним сверяет обновления
ARG PANEL_VERSION=dev
ARG PANEL_COMMIT=
ENV NODE_ENV=production PANEL_VERSION=$PANEL_VERSION PANEL_COMMIT=$PANEL_COMMIT
WORKDIR /app
COPY --from=xray /out/xray /usr/local/bin/xray
COPY --from=build /out/server /app/server
COPY --from=build /src/apps/web/dist /app/web
# расширение Chrome: архив с личной страницы клиента собирает панель
COPY apps/extension /app/extension
ENV EXTENSION_DIR=/app/extension
COPY --from=artifacts /agent-dist /app/agent-dist
COPY --from=artifacts /files /app/files
ENV AGENT_DIR=/app/agent-dist FILES_DIR=/app/files
# Файлы могут прийти с правами 0600, а процесс работает от node.
RUN chmod -R a+rX /app
USER node
EXPOSE 3000
CMD ["node", "server/dist/main.js"]
