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
    'Сервер qWDTT: VPN через инфраструктуру звонков VK. Пользователи добавляются в приложении qWDTT по паролю владельца.',
  params: [
    {
      name: 'WDTT_PASSWORD',
      label: 'Пароль владельца',
      type: 'password',
      required: true,
      secret: true,
      hint: 'для подключения приложения qWDTT к серверу',
    },
    {
      name: 'WDTT_DTLS_PORT',
      label: 'Порт DTLS',
      type: 'port',
      default: '56000',
      required: true,
      hint: 'UDP и TCP, открывается наружу',
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
      hint: 'только внутри сервера',
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
      hint: 'необязательно, для бота управления доступом',
    },
    {
      name: 'WDTT_BOT_TOKEN',
      label: 'Токен Telegram-бота',
      type: 'password',
      secret: true,
      hint: 'необязательно',
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
say "Готово: в приложении qWDTT - адрес $SERVER_HOST, порт $WDTT_DTLS_PORT, пароль владельца из формы"
echo "Admin API: 127.0.0.1:$WDTT_ADMIN_PORT, только внутри сервера (токен в /etc/wdtt/admin.token)"
`,
  preflight: `if systemctl is-active --quiet wdtt 2>/dev/null; then echo "WARN|WDTT уже установлен: он будет переустановлен, база доступа сохранится"; else echo "OK|WDTT не установлен"; fi
# при переустановке порты держит сам WDTT - их не проверяем
if ! systemctl is-active --quiet wdtt 2>/dev/null; then for p in $WDTT_DTLS_PORT $WDTT_ADMIN_PORT; do if ss -ltn -lun | awk '{print $5}' | grep -q ":$p$"; then echo "FAIL|порт $p занят"; else echo "OK|порт $p свободен"; fi; done; fi
if [ "$WDTT_DTLS_PORT" = "$WDTT_WG_PORT" ] || [ "$WDTT_DTLS_PORT" = "$WDTT_ADMIN_PORT" ] || [ "$WDTT_WG_PORT" = "$WDTT_ADMIN_PORT" ]; then echo "FAIL|порты совпадают"; fi
curl -fsS -m 10 -o /dev/null "$PANEL_URL/files/wdtt/deploy.sh" && echo "OK|файлы WDTT на панели доступны" || echo "FAIL|на панели нет файлов WDTT: нужна сборка tools/build-wdtt.sh"`,
  plan: (a) => [
    'Скачать WDTT с панели и проверить контрольную сумму',
    `Установить WDTT: порт DTLS ${a.WDTT_DTLS_PORT}, WireGuard ${a.WDTT_WG_PORT}`,
    `Открыть порт ${a.WDTT_DTLS_PORT} (UDP и TCP)`,
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
    note: 'Пароль владельца нужен для подключения в приложении qWDTT',
  }),
  after:
    'В приложении qWDTT сервер добавляется в\u00a0\u00abСерверах\u00bb: адрес, порт DTLS и пароль владельца. Там же создаются пользователи.',
};
