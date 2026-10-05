import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ARCHES } from '../lib/agent-dist.js';
import { downloadRateLimit, fileSha256, sendFile } from '../lib/file-send.js';

/**
 * Раздача агента: бинарники из AGENT_DIR и install.sh, который ставит его
 * как systemd-юнит. Без авторизации: сам бинарник не секрет, секрет - токен.
 */
export async function agentDistRoutes(app: FastifyInstance, opts: { agentDir: string }) {
  const { agentDir } = opts;

  app.get('/agent/install.sh', async (_req, reply) => {
    reply.type('text/x-shellscript');
    return INSTALL_SH;
  });

  /**
   * Бинарник (или его .gz-копия) с поддержкой Range: агент на медленном канале
   * докачивает с места обрыва. Контрольная сумма всегда от несжатого файла.
   */
  app.get('/agent/download/:arch', { config: downloadRateLimit }, async (req, reply) => {
    let arch = String((req.params as { arch: string }).arch);
    const gz = arch.endsWith('.gz');
    if (gz) arch = arch.slice(0, -3);
    if (!ARCHES.includes(arch)) return reply.code(404).send({ error: 'unknown arch' });
    const file = join(agentDir, `vps-agent-${arch}${gz ? '.gz' : ''}`);
    if (!existsSync(file)) return reply.code(404).send({ error: 'agent binary not built' });
    if (!gz && !req.headers.range) reply.header('x-checksum-sha256', await fileSha256(file));
    return sendFile(req, reply, file);
  });

  app.get('/agent/checksum/:arch', { config: downloadRateLimit }, async (req, reply) => {
    const arch = String((req.params as { arch: string }).arch);
    // %2F в параметре декодируется в "/": без белого списка - выход из каталога агента
    if (!ARCHES.includes(arch)) return reply.code(404).send({ error: 'unknown arch' });
    const file = join(agentDir, `vps-agent-${arch}`);
    if (!existsSync(file)) return reply.code(404).send({ error: 'agent binary not built' });
    return { sha256: await fileSha256(file) };
  });
}

const INSTALL_SH = String.raw`#!/bin/sh
# vps-agent installer. Usage: install.sh --panel https://panel --token <registration token> --key <panel key>
# Ставит только бинарник, конфиг и systemd-юнит. Docker и сервисы не трогает.
set -eu
PANEL=""; TOKEN=""; KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --panel) PANEL="$2"; shift 2;;
    --token) TOKEN="$2"; shift 2;;
    --key) KEY="$2"; shift 2;;
    *) echo "unknown arg: $1" >&2; exit 2;;
  esac
done
[ -n "$PANEL" ] && [ -n "$TOKEN" ] && [ -n "$KEY" ] || { echo "usage: --panel URL --token TOKEN --key KEY" >&2; exit 2; }
# Только https (http - лишь панель на этой же машине, стенд); ключ панели - base64 32 байт
case "$PANEL" in
  https://*) CURL="curl --proto =https";;
  http://localhost:*|http://127.0.0.1:*) CURL="curl";;
  *) echo "panel URL must be https://" >&2; exit 2;;
esac
printf '%s' "$KEY" | grep -Eq '^[A-Za-z0-9+/]{43}=$' || { echo "bad panel key" >&2; exit 2; }
printf '%s' "$TOKEN" | grep -Eq '^[A-Za-z0-9_-]{16,128}$' || { echo "bad token" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 2; }
case "$(uname -m)" in
  x86_64) ARCH=linux-amd64;;
  aarch64|arm64) ARCH=linux-arm64;;
  *) echo "unsupported arch: $(uname -m)" >&2; exit 2;;
esac
TMP=$(mktemp)
$CURL -fsSL "$PANEL/agent/download/$ARCH" -o "$TMP"
SUM=$($CURL -fsSL "$PANEL/agent/checksum/$ARCH" | sed 's/.*"sha256":"\([0-9a-f]*\)".*/\1/')
echo "$SUM  $TMP" | sha256sum -c - >/dev/null || { echo "checksum mismatch" >&2; rm -f "$TMP"; exit 1; }
install -m 0755 "$TMP" /usr/local/bin/vps-agent.new
mv -f /usr/local/bin/vps-agent.new /usr/local/bin/vps-agent
rm -f "$TMP"
mkdir -p /etc/vps-agent && chmod 700 /etc/vps-agent
# Токен регистрации одноразовый: после подключения агент создаст постоянный (панель получит
# только его хеш). Ключ панели - ей агент и верит. Конфиг перезаписываем всегда -
# переустановка должна заново привязать сервер.
printf '{\n  "panelUrl": "%s",\n  "panelKey": "%s",\n  "registrationToken": "%s"\n}\n' "$PANEL" "$KEY" "$TOKEN" > /etc/vps-agent/agent.json
chmod 600 /etc/vps-agent/agent.json
cat > /etc/systemd/system/vps-agent.service <<'UNIT'
[Unit]
Description=vps-agent (panel agent)
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/bin/vps-agent
Restart=always
RestartSec=5
# Потолок на агента вместе с дочерними apt/dpkg при приведении к эталону (сам агент ест около 10 МБ).
MemoryMax=512M

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vps-agent.service
systemctl restart vps-agent.service
echo "vps-agent: installed, $(/usr/local/bin/vps-agent -version)"
`;
