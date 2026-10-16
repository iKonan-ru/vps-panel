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
 * Сервер панели (PANEL_HOST=1): 443 и 80 держит Caddy панели - он и выпускает сертификат
 * имени (панель разрешает его, lib/panel-certs.ts), прокси слушает только свой порт, копию
 * сертификата кладёт vps-naive-cert (при установке и таймером раз в сутки).
 */

/** Сервер панели: копия сертификата от Caddy панели (NaiveConfig.ExternalCert в агенте). */
const CERT_SCRIPT = `#!/bin/sh
# Прокси для браузера на сервере панели: 443 и 80 держит Caddy панели, он и выпускает
# сертификат имени прокси (панель разрешает его в /api/proxy/ask). Здесь - копия для Caddy
# прокси; новая - перечитать конфиг. Запускают установка и таймер vps-naive-cert (раз в сутки).
set -eu
D=$(python3 -c 'import json;print(json.load(open("/etc/vps-naive/config.json"))["domain"])')
dir=/var/lib/vps-naive/certificates/panel/$D
c=""
for n in $(docker ps --filter label=com.docker.compose.service=caddy --format '{{.Names}}'); do
  if docker exec "$n" test -d /data/caddy; then c=$n; break; fi
done
[ -n "$c" ] || { echo "не найден контейнер Caddy панели" >&2; exit 1; }
# рукопожатие на 443: Caddy панели выпустит сертификат, загрузит его в память и продлит вовремя
curl -sk -o /dev/null -m 120 --resolve "$D:443:127.0.0.1" "https://$D/" || true
p=$(docker exec "$c" sh -c "ls -t /data/caddy/certificates/*/$D/$D.crt 2>/dev/null | head -1")
[ -n "$p" ] || { echo "Caddy панели не выпустил сертификат для $D - журнал: docker logs $c" >&2; exit 1; }
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
docker exec "$c" cat "$p" > "$tmp/crt"
docker exec "$c" cat "\${p%.crt}.key" > "$tmp/key"
openssl x509 -in "$tmp/crt" -noout >/dev/null 2>&1 || { echo "сертификат из Caddy панели не читается" >&2; exit 1; }
if cmp -s "$tmp/crt" "$dir/$D.crt" && cmp -s "$tmp/key" "$dir/$D.key"; then
  echo "сертификат $D без изменений"
  exit 0
fi
install -d -m 700 -o vps-naive -g vps-naive /var/lib/vps-naive/certificates /var/lib/vps-naive/certificates/panel "$dir"
install -m 600 -o vps-naive -g vps-naive "$tmp/crt" "$dir/$D.crt"
install -m 600 -o vps-naive -g vps-naive "$tmp/key" "$dir/$D.key"
echo "сертификат $D: $(openssl x509 -in "$dir/$D.crt" -noout -enddate)"
if systemctl is-active --quiet vps-naive; then systemctl reload vps-naive; fi
`;

const CERT_UNITS = `cat > /etc/systemd/system/vps-naive-cert.service <<'U'
[Unit]
Description=VPS Panel: сертификат прокси для браузера от Caddy панели
After=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/vps-naive-cert
U
cat > /etc/systemd/system/vps-naive-cert.timer <<'U'
[Unit]
Description=VPS Panel: сертификат прокси для браузера раз в сутки

[Timer]
OnCalendar=daily
RandomizedDelaySec=1h
Persistent=true

[Install]
WantedBy=timers.target
U
`;

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
    'HTTPS-прокси (Caddy naive) для расширения Chrome: через сервер идёт только трафик браузера, программы на компьютере не нужны. Клиенты получат прокси при синхронизации.',
  liveDefaults: 'naive',
  panelCertParam: 'NAIVE_DOMAIN',
  params: [
    {
      name: 'NAIVE_DOMAIN',
      label: 'Имя прокси',
      type: 'domain',
      required: true,
      hint: 'A-запись должна указывать на IP сервера, обычно <слаг>.<домен панели>',
    },
    {
      name: 'NAIVE_PORT',
      label: 'Порт прокси',
      type: 'port',
      default: '8444',
      required: true,
      hint: 'TCP; порт 443 прокси тоже займёт, если он свободен или занят MTProxyL',
    },
  ],
  timeoutSec: 15 * 60,
  // секретное имя для probe_resistance: на него прокси отвечает 407 (прогрев пароля в
  // расширении); при переустановке скрипт оставляет прежнее - подписки клиентов не меняются
  env: () => ({ NAIVE_SECRET: `${randomBytes(10).toString('hex')}.test` }),
  cleanup: ['/tmp/vps-naive-caddy'],
  script: `${PROLOGUE}${NAIVE_FUNCS}
NAIVE_DOMAIN=$(printf '%s' "$NAIVE_DOMAIN" | tr 'A-Z' 'a-z')
ext=false
[ "$PANEL_HOST" = 1 ] && ext=true
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
if [ "$ext" = true ]; then
  : # сервер панели: 443 и 80 у Caddy панели
elif [ "$mp" = "443" ] && command -v mtproxyl >/dev/null 2>&1; then
  mask=true
elif [ -z "$(port_owner 443)" ]; then
  l443=true
fi
[ "$ext" = false ] && [ -z "$(port_owner 80)" ] && h80=true
secret="$NAIVE_SECRET"
if [ -f /etc/vps-naive/config.json ]; then
  old=$(python3 -c 'import json;print(json.load(open("/etc/vps-naive/config.json")).get("secret",""))' 2>/dev/null || true)
  [ -n "$old" ] && secret="$old"
fi
python3 - "$NAIVE_DOMAIN" "$NAIVE_PORT" "$l443" "$mask" "$h80" "$secret" "$ext" <<'PY'
import json, sys
d, port, l443, mask, h80, secret, ext = sys.argv[1:8]
cfg = {"domain": d, "port": int(port), "listen443": l443 == "true", "mask443": mask == "true",
       "http80": h80 == "true", "secret": secret, "externalCert": ext == "true"}
with open("/etc/vps-naive/config.json", "w") as f:
    json.dump(cfg, f, indent=2)
PY
chmod 600 /etc/vps-naive/config.json
/usr/local/bin/vps-agent -naive-render
if [ "$ext" = true ]; then
  echo "сервер панели: 443 и 80 у Caddy панели, прокси только на порту $NAIVE_PORT"
  say "Сертификат $NAIVE_DOMAIN выпускает Caddy панели (до 2 минут)"
  cat > /usr/local/sbin/vps-naive-cert <<'CERT'
${CERT_SCRIPT}CERT
  chmod 755 /usr/local/sbin/vps-naive-cert
  /usr/local/sbin/vps-naive-cert
  ${CERT_UNITS}  systemctl daemon-reload
  systemctl enable --now vps-naive-cert.timer >/dev/null 2>&1
else
  echo "443: $([ $mask = true ] && echo 'маска MTProxyL' || ([ $l443 = true ] && echo 'Caddy сам' || echo 'нет'))  80: $([ $h80 = true ] && echo 'Caddy (HTTP-01)' || echo 'нет')"
fi

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
  [ "$code" = 200 ] || echo "ВНИМАНИЕ: на порту 443 прокси не отвечает - расширение будет подключаться к порту $NAIVE_PORT"
fi
say "Готово: клиенты получат прокси при синхронизации, адрес расширение возьмёт из подписки"
if [ "\${PANEL_HOST:-}" = 1 ]; then
  echo 'Это сервер панели: клиенты получат прокси, только если он включён в "Клиенты" - "Серверы клиентов"'
fi
`,
  preflight: `${NAIVE_FUNCS}
D=$(printf '%s' "$NAIVE_DOMAIN" | tr 'A-Z' 'a-z')
ip=$(getent ahostsv4 "$D" 2>/dev/null | awk '{print $1; exit}')
if [ -z "$ip" ]; then echo "FAIL|имени $D нет в DNS: нужна A-запись на $SERVER_HOST";
elif [ "$ip" = "$SERVER_HOST" ]; then echo "OK|$D указывает на этот сервер ($ip)";
else echo "FAIL|$D указывает на $ip, а не на $SERVER_HOST: A-запись нужно сменить или дождаться обновления DNS"; fi
o=$(port_owner "$NAIVE_PORT")
if [ -z "$o" ]; then echo "OK|порт $NAIVE_PORT свободен"; elif [ "$o" = caddy ] && naive_unit_active; then echo "OK|порт $NAIVE_PORT занят этим прокси (переустановка)"; else echo "FAIL|порт $NAIVE_PORT занят ($o)"; fi
mp=$(mt_port)
if [ "$PANEL_HOST" = 1 ]; then
c=$(docker ps --filter label=com.docker.compose.service=caddy --format '{{.Names}}' 2>/dev/null | head -1)
if [ -n "$c" ]; then echo "OK|сервер панели: сертификат выпустит Caddy панели, прокси будет только на порту $NAIVE_PORT"; else echo "FAIL|контейнер Caddy панели не найден"; fi
else
if [ "$mp" = "443" ] && command -v mtproxyl >/dev/null 2>&1; then
  if [ -f /opt/mtproxyl/superexpert.toml ]; then echo "FAIL|MTProxyL в режиме суперэксперта: порт 443 для прокси недоступен"; else echo "WARN|порт 443 занят MTProxyL: прокси будет отвечать через него, MTProxyL перезапустится и соединения Telegram прервутся на несколько секунд"; fi
elif [ -z "$(port_owner 443)" ]; then echo "OK|порт 443 свободен, прокси займёт и его";
elif [ "$(port_owner 443)" = caddy ] && naive_unit_active; then echo "OK|порт 443 занят этим прокси (переустановка)";
else echo "WARN|порт 443 занят ($(port_owner 443)): прокси будет только на порту $NAIVE_PORT, сертификат выпускается через порт 80"; fi
o80=$(port_owner 80)
if [ -z "$o80" ] || { [ "$o80" = caddy ] && naive_unit_active; }; then echo "OK|порт 80 свободен для выпуска сертификата"; else echo "WARN|порт 80 занят ($o80): сертификат выпускается через порт 443"; fi
# сертификат выпускается через 443 (сам или маской MTProxyL) или 80; оба чужие (сервер панели:
# их держит Caddy панели) - Let's Encrypt не достучится, ставить бессмысленно
o443=$(port_owner 443)
ok443=false; { [ "$mp" = "443" ] && command -v mtproxyl >/dev/null 2>&1; } || [ -z "$o443" ] || { [ "$o443" = caddy ] && naive_unit_active; } && ok443=true
ok80=false; [ -z "$o80" ] || { [ "$o80" = caddy ] && naive_unit_active; } && ok80=true
if [ "$ok443" = false ] && [ "$ok80" = false ]; then echo "FAIL|порты 443 и 80 заняты ($o443, $o80): сертификат для $D не выпустить"; fi
fi
if naive_unit_active; then echo "WARN|прокси уже установлен: он перезапустится, подписки клиентов не изменятся"; fi
curl -fsS -m 10 -o /dev/null "$PANEL_URL/files/sha256/naive/caddy-linux-amd64" && echo "OK|файлы прокси на панели доступны" || echo "FAIL|на панели нет файлов прокси: нужна сборка tools/build-naive.sh"`,
  plan: (a) => [
    'Скачать прокси с панели и проверить контрольную сумму',
    `Запустить прокси для ${a.NAIVE_DOMAIN || '<имя>'} на порту ${a.NAIVE_PORT}`,
    'Занять и порт 443, если он свободен; если он занят MTProxyL, отвечать через него (MTProxyL перезапустится)',
    "Получить сертификат Let's Encrypt; на сервере панели его выпускает Caddy панели",
    'Открыть порты прокси',
    'Выдать прокси клиентам при синхронизации',
  ],
  after:
    'Клиенты получат прокси при синхронизации. Расширение и инструкция\u00a0\u2014 на личной странице клиента.',
};

export const naiveUninstallCmd: CommandDef = {
  id: 'naive-uninstall',
  title: 'Удалить прокси для браузера',
  group: 'maintain',
  service: 'Браузер (naive)',
  description:
    'Удаляет прокси для браузера вместе с сертификатом. Расширения клиентов перестанут работать через этот сервер.',
  params: [
    {
      name: 'CONFIRM',
      label: 'Подтверждение',
      type: 'select',
      default: 'no',
      required: true,
      options: [
        { value: 'no', label: 'не удалять' },
        { value: 'yes', label: 'удалить' },
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
systemctl disable --now vps-naive-cert.timer 2>/dev/null || true
rm -f /etc/systemd/system/vps-naive.service /etc/systemd/system/vps-naive-cert.service /etc/systemd/system/vps-naive-cert.timer /usr/local/sbin/vps-naive-cert
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
  preflight: `if [ -f /etc/systemd/system/vps-naive.service ]; then echo "WARN|прокси для браузера установлен: клиенты потеряют этот сервер в расширении"; else echo "FAIL|прокси для браузера не установлен"; fi
if [ -f /etc/vps-naive/config.json ] && grep -q '"mask443": true' /etc/vps-naive/config.json; then echo "WARN|MTProxyL перезапустится, соединения Telegram прервутся на несколько секунд"; fi`,
  plan: () => [
    'Остановить и удалить прокси с сертификатом',
    'Отключить прокси от порта 443 в MTProxyL, если он отвечал через него (MTProxyL перезапустится)',
    'Закрыть порты прокси',
    'Отключить клиентов от прокси на этом сервере',
  ],
  dropsBindings: ['naive'],
};
