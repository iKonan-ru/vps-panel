import { randomBytes } from 'node:crypto';
import type { CommandDef } from './types.js';
import { NAIVE_FUNCS, PROLOGUE } from './util.js';

/**
 * Прокси для браузера: Caddy с forwardproxy (naive), служба
 * vps-naive. Бинарник собирает tools/build-naive.sh, панель раздаёт по /files/naive/.
 * Caddyfile собирает агент (vps-agent -naive-render) из config.json и users.json -
 * пользователей потом ведёт сверка глобальных клиентов через naive.exec.
 * 443: если его держит MTProxyL - маска telemt (SNI имени -> 127.0.0.1:<порт>), если свободен -
 * Caddy слушает его сам. Сертификат Caddy выпускает сам: TLS-ALPN-01 через 443 и HTTP-01 на 80,
 * если 80 свободен. Бинарник называется caddy - port-sync откроет его порты сам.
 * MTProxyL можно поставить и после прокси, и удалить: его команды переключают режим 443 прокси
 * сами (NAIVE_FUNCS в util.ts).
 */

const UNIT = `[Unit]
Description=VPS Panel: прокси для браузера (Caddy naive)
After=network-online.target
Wants=network-online.target

[Service]
User=vps-naive
Group=vps-naive
ExecStart=/opt/vps-naive/caddy run --config /etc/vps-naive/Caddyfile --adapter caddyfile
ExecReload=/opt/vps-naive/caddy reload --config /etc/vps-naive/Caddyfile --adapter caddyfile --address unix//run/vps-naive/admin.sock --force
Environment=HOME=/var/lib/vps-naive XDG_DATA_HOME=/var/lib/vps-naive XDG_CONFIG_HOME=/var/lib/vps-naive
RuntimeDirectory=vps-naive
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/var/lib/vps-naive
LimitNOFILE=1048576
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
`;

export const naiveCmd: CommandDef = {
  id: 'naive',
  title: 'Прокси для браузера (naive)',
  group: 'install',
  service: 'Браузер (naive)',
  description:
    'HTTPS-прокси Caddy с forwardproxy (naive) для расширения Chrome: выход через сервер только из браузера, без программ на компьютере. Сертификат на имя сервера Caddy выпускает сам; пользователи - глобальные клиенты панели.',
  liveDefaults: 'naive',
  params: [
    {
      name: 'NAIVE_DOMAIN',
      label: 'Имя прокси',
      type: 'domain',
      required: true,
      hint: 'A-запись этого имени должна указывать на IP сервера (обычно <слаг>.<домен панели>)',
    },
    {
      name: 'NAIVE_PORT',
      label: 'Порт прокси',
      type: 'port',
      default: '8444',
      required: true,
      hint: 'TCP, открывается наружу; на 443 прокси отвечает через маску MTProxyL или сам, если 443 свободен',
    },
  ],
  timeoutSec: 15 * 60,
  // секретное имя для probe_resistance: на него прокси отвечает 407 (прогрев пароля в
  // расширении); при переустановке скрипт оставляет прежнее - подписки клиентов не меняются
  env: () => ({ NAIVE_SECRET: `${randomBytes(10).toString('hex')}.test` }),
  cleanup: ['/tmp/vps-naive-caddy'],
  script: `${PROLOGUE}${NAIVE_FUNCS}
NAIVE_DOMAIN=$(printf '%s' "$NAIVE_DOMAIN" | tr 'A-Z' 'a-z')
/usr/local/bin/vps-agent -h 2>&1 | grep -q naive-render || { echo "агент устарел: обнови агента сервера" >&2; exit 2; }
arch=$(uname -m)
case "$arch" in
  x86_64) bin=caddy-linux-amd64;;
  aarch64|arm64) bin=caddy-linux-arm64;;
  *) echo "архитектура $arch не поддерживается" >&2; exit 2;;
esac
need python3 || apt_install python3
say "Скачиваю $bin с панели"
fetch "$PANEL_URL/files/naive/$bin" -o /tmp/vps-naive-caddy
sum=$(fetch "$PANEL_URL/files/sha256/naive/$bin" | sed 's/.*"sha256":"\\([0-9a-f]*\\)".*/\\1/')
echo "$sum  /tmp/vps-naive-caddy" | sha256sum -c - >/dev/null || { echo "контрольная сумма бинарника не совпала" >&2; exit 1; }

say "Пользователь, каталоги, бинарник"
id vps-naive >/dev/null 2>&1 || useradd --system --no-create-home --home-dir /var/lib/vps-naive --shell /usr/sbin/nologin vps-naive
install -d -m 755 /opt/vps-naive
naive_unit_active && systemctl stop vps-naive || true
install -m 755 /tmp/vps-naive-caddy /opt/vps-naive/caddy
install -d -m 750 -o root -g vps-naive /etc/vps-naive
install -d -m 700 -o vps-naive -g vps-naive /var/lib/vps-naive

mask=false; l443=false; h80=false
mp=$(mt_port)
if [ "$mp" = "443" ] && command -v mtproxyl >/dev/null 2>&1; then
  mask=true
elif [ -z "$(port_owner 443)" ]; then
  l443=true
fi
[ -z "$(port_owner 80)" ] && h80=true
secret="$NAIVE_SECRET"
if [ -f /etc/vps-naive/config.json ]; then
  old=$(python3 -c 'import json;print(json.load(open("/etc/vps-naive/config.json")).get("secret",""))' 2>/dev/null || true)
  [ -n "$old" ] && secret="$old"
fi
python3 - "$NAIVE_DOMAIN" "$NAIVE_PORT" "$l443" "$mask" "$h80" "$secret" <<'PY'
import json, sys
d, port, l443, mask, h80, secret = sys.argv[1:7]
cfg = {"domain": d, "port": int(port), "listen443": l443 == "true", "mask443": mask == "true",
       "http80": h80 == "true", "secret": secret}
with open("/etc/vps-naive/config.json", "w") as f:
    json.dump(cfg, f, indent=2)
PY
chmod 600 /etc/vps-naive/config.json
/usr/local/bin/vps-agent -naive-render
echo "443: $([ $mask = true ] && echo 'маска MTProxyL' || ([ $l443 = true ] && echo 'Caddy сам' || echo 'нет'))  80: $([ $h80 = true ] && echo 'Caddy (HTTP-01)' || echo 'нет')"

say "Служба vps-naive"
cat > /etc/systemd/system/vps-naive.service <<'UNIT'
${UNIT}UNIT
systemctl daemon-reload
systemctl enable vps-naive >/dev/null 2>&1
systemctl restart vps-naive
sleep 2
systemctl is-active vps-naive

if [ "$mask" = true ]; then
  say "MTProxyL: маска telemt $NAIVE_DOMAIN -> 127.0.0.1:$NAIVE_PORT, перезапуск прокси"
  naive_mask_on "$NAIVE_DOMAIN" "$NAIVE_PORT" || { echo "MTProxyL не принял маску" >&2; exit 1; }
fi

if [ -x /usr/local/sbin/vps-portsync ]; then
  say "port-sync: открываю порт прокси"
  /usr/local/sbin/vps-portsync | tail -n 5 || true
fi

say "Жду сертификат Let's Encrypt (до 3 минут)"
crt=""
for i in $(seq 1 36); do
  crt=$(ls /var/lib/vps-naive/certificates/*/"$NAIVE_DOMAIN"/"$NAIVE_DOMAIN".crt 2>/dev/null | head -1 || true)
  [ -n "$crt" ] && break
  sleep 5
done
if [ -z "$crt" ]; then
  echo "сертификат не выпущен - журнал службы:" >&2
  journalctl -u vps-naive --since "-5 min" --no-pager | grep -iE "error|challenge|obtain" | tail -n 15 >&2 || true
  exit 1
fi
openssl x509 -in "$crt" -noout -enddate -issuer 2>/dev/null || true

say "Проверка"
code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$NAIVE_DOMAIN:$NAIVE_PORT:127.0.0.1" "https://$NAIVE_DOMAIN:$NAIVE_PORT/" || true)
echo "порт $NAIVE_PORT: HTTP $code"
[ "$code" = 200 ] || { echo "прокси не отвечает на порту $NAIVE_PORT" >&2; exit 1; }
if [ "$mask" = true ] || [ "$l443" = true ]; then
  code=$(curl -s -o /dev/null -w '%{http_code}' --resolve "$NAIVE_DOMAIN:443:127.0.0.1" "https://$NAIVE_DOMAIN/" || true)
  echo "порт 443: HTTP $code"
  [ "$code" = 200 ] || echo "ВНИМАНИЕ: на 443 прокси не отвечает - расширение будет ходить на $NAIVE_PORT"
fi
say "Готово: пользователи - глобальные клиенты панели (сверка заведёт их сама), расширение берёт адрес из подписки"
`,
  preflight: `${NAIVE_FUNCS}
/usr/local/bin/vps-agent -h 2>&1 | grep -q naive-render && echo "OK|агент умеет собирать конфиг прокси" || echo "FAIL|агент устарел: обнови агента сервера"
D=$(printf '%s' "$NAIVE_DOMAIN" | tr 'A-Z' 'a-z')
ip=$(getent ahostsv4 "$D" 2>/dev/null | awk '{print $1; exit}')
if [ -z "$ip" ]; then echo "FAIL|имя $D не находится в DNS - заведи A-запись на $SERVER_HOST";
elif [ "$ip" = "$SERVER_HOST" ]; then echo "OK|$D указывает на этот сервер ($ip)";
else echo "FAIL|$D указывает на $ip, а сервер - $SERVER_HOST: поправь A-запись (или подожди обновления DNS)"; fi
o=$(port_owner "$NAIVE_PORT")
if [ -z "$o" ]; then echo "OK|порт $NAIVE_PORT свободен"; elif [ "$o" = caddy ] && naive_unit_active; then echo "OK|порт $NAIVE_PORT держит прокси (переустановка)"; else echo "FAIL|порт $NAIVE_PORT занят ($o)"; fi
mp=$(mt_port)
if [ "$mp" = "443" ] && command -v mtproxyl >/dev/null 2>&1; then
  if [ -f /opt/mtproxyl/superexpert.toml ]; then echo "FAIL|MTProxyL в режиме суперэксперта: маску 443 задать нельзя"; else echo "WARN|443 держит MTProxyL: будет маска telemt для $D, прокси Telegram перезапустится (соединения прервутся на несколько секунд)"; fi
elif [ -z "$(port_owner 443)" ]; then echo "OK|443 свободен - прокси будет слушать и его";
elif [ "$(port_owner 443)" = caddy ] && naive_unit_active; then echo "OK|443 держит прокси (переустановка)";
else echo "WARN|443 занят ($(port_owner 443)): прокси только на порту $NAIVE_PORT, сертификат - только через 80"; fi
o80=$(port_owner 80)
if [ -z "$o80" ] || { [ "$o80" = caddy ] && naive_unit_active; }; then echo "OK|80 свободен - для выпуска сертификата (HTTP-01)"; else echo "WARN|80 занят ($o80): сертификат - только через 443"; fi
if naive_unit_active; then echo "WARN|прокси уже установлен: служба перезапустится, пользователи и секретное имя сохранятся"; fi
curl -fsS -m 10 -o /dev/null "$PANEL_URL/files/sha256/naive/caddy-linux-amd64" && echo "OK|бинарник прокси на панели есть" || echo "FAIL|панель не отдаёт /files/naive - собери tools/build-naive.sh"`,
  plan: (a) => [
    'Скачать с панели Caddy с forwardproxy (сборка tools/build-naive.sh), проверить sha256',
    'Пользователь vps-naive, /opt/vps-naive, /etc/vps-naive (config.json, users.json, Caddyfile от агента), /var/lib/vps-naive',
    `Служба vps-naive: HTTPS-прокси на ${a.NAIVE_PORT}/tcp для ${a.NAIVE_DOMAIN || '<имя>'}; без пароля - сайт-заглушка`,
    '443: если его держит MTProxyL - маска telemt (перезапуск прокси Telegram), если свободен - Caddy сам; 80 - для выпуска сертификата, если свободен',
    "port-sync откроет порты процесса caddy; Caddy выпустит сертификат Let's Encrypt и будет продлевать его сам",
    'Пользователей заведёт сверка глобальных клиентов; адрес и пароль клиент получает в подписке расширения',
  ],
  after:
    'Клиенты получат прокси сверкой (страница Клиенты - "Сверить сейчас"). Расширение Chrome и шаги установки - на личной странице клиента, блок "Браузер Chrome".',
};

export const naiveUninstallCmd: CommandDef = {
  id: 'naive-uninstall',
  title: 'Удалить прокси для браузера',
  group: 'maintain',
  service: 'Браузер (naive)',
  description:
    'Снести прокси для браузера: служба vps-naive, Caddy, сертификат и пользователи; маска 443 в MTProxyL снимается. Расширения клиентов перестанут работать через этот сервер.',
  params: [
    {
      name: 'CONFIRM',
      label: 'Подтверждение',
      type: 'select',
      default: 'no',
      required: true,
      options: [
        { value: 'no', label: 'нет, не удалять' },
        { value: 'yes', label: 'да, удалить' },
      ],
    },
  ],
  timeoutSec: 5 * 60,
  script: `${PROLOGUE}
[ "$CONFIRM" = "yes" ] || { echo "удаление не подтверждено" >&2; exit 2; }
[ -f /etc/systemd/system/vps-naive.service ] || [ -d /etc/vps-naive ] || { echo "прокси для браузера не установлен" >&2; exit 3; }
dom=""
mask=false
if [ -f /etc/vps-naive/config.json ]; then
  dom=$(python3 -c 'import json;print(json.load(open("/etc/vps-naive/config.json")).get("domain",""))' 2>/dev/null || true)
  mask=$(python3 -c 'import json;print(str(json.load(open("/etc/vps-naive/config.json")).get("mask443",False)).lower())' 2>/dev/null || echo false)
fi
say "Останавливаю службу vps-naive"
systemctl disable --now vps-naive 2>/dev/null || true
rm -f /etc/systemd/system/vps-naive.service
systemctl daemon-reload
if [ "$mask" = true ] && [ -n "$dom" ] && command -v mtproxyl >/dev/null 2>&1; then
  say "MTProxyL: снимаю маску $dom, перезапуск прокси"
  mtproxyl expert clear censorship.exclusive_mask "$dom" --no-apply || true
  mtproxyl expert apply </dev/null || true
  mtproxyl restart </dev/null || true
fi
rm -rf /opt/vps-naive /etc/vps-naive /var/lib/vps-naive
userdel vps-naive 2>/dev/null || true
if [ -x /usr/local/sbin/vps-portsync ]; then
  say "port-sync: закрываю порты прокси"
  /usr/local/sbin/vps-portsync | tail -n 5 || true
fi
say "Готово"
`,
  preflight: `if [ -f /etc/systemd/system/vps-naive.service ]; then echo "WARN|прокси для браузера установлен: удалятся служба, сертификат и пользователи; клиенты потеряют этот сервер в расширении"; else echo "FAIL|прокси для браузера не установлен"; fi
if [ -f /etc/vps-naive/config.json ] && grep -q '"mask443": true' /etc/vps-naive/config.json; then echo "WARN|маска 443 в MTProxyL снимется - прокси Telegram перезапустится"; fi`,
  plan: () => [
    'Остановить и удалить службу vps-naive',
    'Снять маску 443 в MTProxyL (если была) и перезапустить прокси Telegram',
    'Удалить /opt/vps-naive, /etc/vps-naive, /var/lib/vps-naive (сертификат), пользователя vps-naive',
    'port-sync закроет порты прокси; сверка уберёт привязки клиентов',
  ],
};
