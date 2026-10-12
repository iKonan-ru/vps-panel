import { randomBytes } from 'node:crypto';
import type { CommandDef } from './types.js';
import { PROLOGUE, WDTT_FW_FUNCS } from './util.js';

/**
 * WDTT (qWDTT) без приложения. Приложение делает ровно это: заливает deploy.sh,
 * бинарник wdtt-server и файлы с секретами в /tmp, затем запускает скрипт.
 * deploy.sh и бинарник (собранный из исходников qWDTT) панель раздаёт по /files/wdtt/.
 */
export const wdttCmd: CommandDef = {
  id: 'wdtt',
  title: 'WDTT',
  group: 'install',
  service: 'WDTT',
  description:
    'Сервер qWDTT (VPN через TURN-инфраструктуру звонков VK) без приложения: deploy.sh и бинарник wdtt-server отдаёт панель, секреты передаются файлами. Пользователи добавляются из приложения по паролю владельца.',
  params: [
    {
      name: 'WDTT_PASSWORD',
      label: 'Пароль владельца',
      type: 'password',
      required: true,
      secret: true,
      hint: 'им приложение подключается к серверу; хранится только на сервере',
    },
    {
      name: 'WDTT_DTLS_PORT',
      label: 'Порт DTLS',
      type: 'port',
      default: '56000',
      required: true,
      hint: 'udp и tcp, открывается наружу',
    },
    {
      name: 'WDTT_WG_PORT',
      label: 'Порт WireGuard',
      type: 'port',
      default: '56001',
      required: true,
      hint: 'только внутри сервера',
    },
    {
      name: 'WDTT_ADMIN_PORT',
      label: 'Порт admin API',
      type: 'port',
      default: '56002',
      required: true,
      hint: 'только на самом сервере (127.0.0.1): панель обращается к нему через агента',
    },
    {
      name: 'WDTT_DNS_SERVERS',
      label: 'DNS для клиентов',
      type: 'string',
      default: '1.1.1.1,1.0.0.1',
      required: true,
      pattern: '^([0-9.]+)(,[0-9.]+)*$',
    },
    {
      name: 'WDTT_ADMIN_ID',
      label: 'Telegram ID администратора',
      type: 'string',
      pattern: '^([0-9]+)?$',
      hint: 'необязательно: бот управления доступом',
    },
    {
      name: 'WDTT_BOT_TOKEN',
      label: 'Токен Telegram-бота',
      type: 'password',
      secret: true,
      hint: 'необязательно, вместе с ID',
    },
  ],
  timeoutSec: 20 * 60,
  env: () => ({ WDTT_ADMIN_TOKEN: randomBytes(24).toString('hex') }),
  files: ({ answers }) => {
    const f: Record<string, string> = {
      '/tmp/wdtt-main.password': `${answers.WDTT_PASSWORD ?? ''}\n`,
    };
    if (answers.WDTT_BOT_TOKEN) f['/tmp/wdtt-bot.token'] = `${answers.WDTT_BOT_TOKEN}\n`;
    return f;
  },
  cleanup: [
    '/tmp/wdtt-main.password',
    '/tmp/wdtt-bot.token',
    '/tmp/wdtt-admin.token',
    '/tmp/wdtt-server',
    '/tmp/wdtt-deploy.sh',
  ],
  script: `${PROLOGUE}
arch=$(uname -m)
case "$arch" in
  x86_64) bin=wdtt-server-linux-amd64;;
  aarch64|arm64) bin=wdtt-server-linux-arm64;;
  *) echo "архитектура $arch не поддерживается" >&2; exit 2;;
esac
say "Скачиваю deploy.sh и $bin с панели"
fetch "$PANEL_URL/files/wdtt/deploy.sh" -o /tmp/wdtt-deploy.sh
fetch "$PANEL_URL/files/wdtt/$bin" -o /tmp/wdtt-server
sum=$(fetch "$PANEL_URL/files/sha256/wdtt/$bin" | sed 's/.*"sha256":"\\([0-9a-f]*\\)".*/\\1/')
echo "$sum  /tmp/wdtt-server" | sha256sum -c - >/dev/null || { echo "контрольная сумма бинарника не совпала" >&2; exit 1; }
chmod +x /tmp/wdtt-server
printf '%s\\n' "$WDTT_ADMIN_TOKEN" > /tmp/wdtt-admin.token
chmod 600 /tmp/wdtt-admin.token /tmp/wdtt-main.password
export WDTT_DTLS_PORT WDTT_WG_PORT WDTT_ADMIN_PORT WDTT_DNS_SERVERS WDTT_ADMIN_ID
export WDTT_SSH_PORT="$SERVER_SSH_PORT"
say "Запускаю deploy.sh (порты: DTLS $WDTT_DTLS_PORT, WG $WDTT_WG_PORT, admin $WDTT_ADMIN_PORT)"
apt_wait
bash /tmp/wdtt-deploy.sh install </dev/null
${WDTT_FW_FUNCS}
if portsync_governs; then
  say "Порты ведут ufw и port-sync: открываю порты WDTT в ufw, убираю зеркальные правила iptables"
  timeout 120 /usr/local/sbin/vps-portsync >/dev/null 2>&1 || true
  wdtt_mirrors_drop
fi
say "Проверка"
systemctl is-active wdtt
ss -lunp | grep -E ":$WDTT_DTLS_PORT " | head -1 || true
say "Готово. Подключение из приложения qWDTT: адрес $SERVER_HOST, порт $WDTT_DTLS_PORT, пароль владельца из формы."
echo "Admin API: 127.0.0.1:$WDTT_ADMIN_PORT, только на сервере (токен в /etc/wdtt/admin.token); панель обращается к нему через агента."
`,
  preflight: `if systemctl is-active --quiet wdtt 2>/dev/null; then echo "WARN|WDTT уже установлен и запущен: deploy.sh переустановит службу, база доступа /etc/wdtt/passwords.json сохранится"; else echo "OK|WDTT не установлен"; fi
# при переустановке порты держит сам WDTT - их не проверяем
if ! systemctl is-active --quiet wdtt 2>/dev/null; then for p in $WDTT_DTLS_PORT $WDTT_ADMIN_PORT; do if ss -ltn -lun | awk '{print $5}' | grep -q ":$p$"; then echo "FAIL|порт $p занят"; else echo "OK|порт $p свободен"; fi; done; fi
if [ "$WDTT_DTLS_PORT" = "$WDTT_WG_PORT" ] || [ "$WDTT_DTLS_PORT" = "$WDTT_ADMIN_PORT" ] || [ "$WDTT_WG_PORT" = "$WDTT_ADMIN_PORT" ]; then echo "FAIL|порты должны быть разными"; fi
curl -fsS -m 10 -o /dev/null "$PANEL_URL/files/wdtt/deploy.sh" && echo "OK|файлы WDTT на панели доступны" || echo "FAIL|панель не отдаёт /files/wdtt/deploy.sh - положи файлы в deploy/files/wdtt (tools/build-wdtt.sh)"`,
  plan: (a) => [
    'Скачать с панели deploy.sh и wdtt-server (сборка из исходников qWDTT), проверить sha256',
    'Записать пароль владельца и токен admin API в /tmp; deploy.sh перенесёт их в /etc/wdtt с правами 0600',
    `deploy.sh: пакеты, sysctl, NAT (MASQUERADE 10.66.0.0/16), правила iptables для ${a.WDTT_DTLS_PORT} и ${a.WDTT_WG_PORT}, служба wdtt`,
    `port-sync откроет ${a.WDTT_DTLS_PORT}/udp+tcp (процесс wdtt-server известен); admin API ${a.WDTT_ADMIN_PORT} - только на 127.0.0.1`,
    'После установки агент увидит сервис WDTT: пароли и ссылки - во вкладке WDTT сервера',
  ],
  access: ({ server, answers }) => ({
    kind: 'wdtt',
    title: 'WDTT',
    fields: [
      {
        label: 'Сервер',
        value: `${server.host}:${answers.WDTT_DTLS_PORT} (DTLS), ${answers.WDTT_WG_PORT} (WireGuard)`,
      },
      { label: 'Пароль владельца', value: answers.WDTT_PASSWORD ?? '', secret: true },
      ...(answers.WDTT_ADMIN_ID
        ? [{ label: 'Telegram ID администратора', value: answers.WDTT_ADMIN_ID }]
        : []),
    ],
    note: 'Пароль владельца вводится в клиентском приложении WDTT при подключении к серверу.',
  }),
  after:
    'В приложении qWDTT: Серверы -> добавить -> адрес сервера, порт DTLS и пароль владельца. Пользователи создаются там же.',
};
