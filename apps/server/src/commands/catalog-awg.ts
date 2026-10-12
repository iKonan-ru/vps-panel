import { type AwgProfile, generateAwgParams, validateAwgParams } from '../lib/awg-params.js';
import type { CommandDef } from './types.js';
import { ENSURE_DOCKER, PROLOGUE } from './util.js';

/**
 * Сервер AmneziaWG в контейнере, как у приложения Amnezia (client/server_scripts/awg):
 * основной экземпляр amnezia-awg2 (его видит приложение) или дополнительный
 * amnezia-awg2-<порт> со своей версией, портом и подсетью.
 */

/** Образ закреплён тегом: latest может сменить протокол под уже выданными конфигами. */
const IMAGE = 'amneziavpn/amneziawg-go:3.1.20260828';

// awg-quick берёт модуль ядра, если он загружен, даже старый (модуль 1.x не знает параметров
// 3.x: "Invalid argument"). AWG_USERSPACE=1 - всегда amneziawg-go; решает start.sh.
const DOCKERFILE = `FROM ${IMAGE}
LABEL maintainer="AmneziaVPN"
RUN apk add --no-cache bash curl dumb-init
RUN apk --update upgrade --no-cache
RUN sed -i -e 's/if ! cmd ip link add "\\$INTERFACE" type amneziawg; then/if [[ -n $AWG_USERSPACE ]] || ! cmd ip link add "$INTERFACE" type amneziawg; then/' -e 's/\\[\\[ -e \\/sys\\/module\\/amneziawg \\]\\] ||/[[ -z $AWG_USERSPACE \\&\\& -e \\/sys\\/module\\/amneziawg ]] ||/' /usr/bin/awg-quick && grep -q AWG_USERSPACE /usr/bin/awg-quick
RUN mkdir -p /opt/amnezia
RUN echo -e "#!/bin/bash\\ntail -f /dev/null" > /opt/amnezia/start.sh
RUN chmod a+x /opt/amnezia/start.sh
ENTRYPOINT [ "dumb-init", "/opt/amnezia/start.sh" ]
CMD [ "" ]
`;

// @SUBNET@ и @CIDR@ подставляются при сборке файлов команды.
const START_SH = `#!/bin/bash
echo "Container startup"
# модуль amneziawg хоста старше 3.x не принимает параметры 3.x - тогда amneziawg-go
MOD=$(cat /sys/module/amneziawg/version 2>/dev/null)
if [ -n "$MOD" ] && [ "\${MOD%%.*}" -lt 3 ]; then
  export AWG_USERSPACE=1
  echo "модуль ядра amneziawg $MOD старше 3.x: работает amneziawg-go"
fi
awg-quick down /opt/amnezia/awg/awg0.conf
if [ -f /opt/amnezia/awg/awg0.conf ]; then (awg-quick up /opt/amnezia/awg/awg0.conf); fi
iptables -A INPUT -i awg0 -j ACCEPT
iptables -A FORWARD -i awg0 -j ACCEPT
iptables -A OUTPUT -o awg0 -j ACCEPT
iptables -A FORWARD -i awg0 -o eth0 -s @SUBNET@/@CIDR@ -j ACCEPT
iptables -A FORWARD -i awg0 -o eth1 -s @SUBNET@/@CIDR@ -j ACCEPT
iptables -A FORWARD -m state --state ESTABLISHED,RELATED -j ACCEPT
iptables -t nat -A POSTROUTING -s @SUBNET@/@CIDR@ -o eth0 -j MASQUERADE
iptables -t nat -A POSTROUTING -s @SUBNET@/@CIDR@ -o eth1 -j MASQUERADE
tail -f /dev/null
`;

/** Порядок ключей - как у приложения; I1-I5 оно хранит закомментированными ("# I1 = ..."). */
const ORDER = [
  'Jc',
  'Jmin',
  'Jmax',
  'S1',
  'S2',
  'S3',
  'S4',
  'H1',
  'H2',
  'H3',
  'H4',
  'HeaderProtectionKey',
  'ContentPaddingAddition',
  'RekeyAfterTime',
  'RekeyTimeout',
  'RejectAfterTime',
  'KeepaliveTimeout',
  'MaxHandshakeAttempts',
  'RandomTrailers',
  'DisableCookies',
];

/** awg0.conf сервера; ключ сервера подставляет скрипт (@PRIVKEY@). */
function awgConf(subnet: string, port: string, p: Record<string, string>): string {
  const body = ORDER.filter((k) => p[k]).map((k) => `${k} = ${p[k]}`);
  const special = ['I1', 'I2', 'I3', 'I4', 'I5'].filter((k) => p[k]).map((k) => `# ${k} = ${p[k]}`);
  return `[Interface]\nPrivateKey = @PRIVKEY@\nAddress = ${subnet}/24\nListenPort = ${port}\n${[...body, ...special].join('\n')}\n`;
}

const profileOf = (a: Record<string, string>): AwgProfile =>
  a.AWG_VERSION === '2.0' || a.AWG_VERSION === '2'
    ? '2.0'
    : a.AWG_VERSION === '1.0'
      ? '1.0'
      : '3.1';

/** Имя контейнера: основной - amnezia-awg2, дополнительный - amnezia-awg2-<порт>. */
const containerOf = (a: Record<string, string>) =>
  a.AWG_INSTANCE === 'extra' ? `amnezia-awg2-${a.AWG_SERVER_PORT ?? ''}` : 'amnezia-awg2';

function genEnv(a: Record<string, string>): Record<string, string> {
  return {
    CONTAINER_NAME: containerOf(a),
    AWG_SUBNET_IP: a.AWG_SUBNET_IP ?? '10.8.1.0',
    AWG_SERVER_PORT: a.AWG_SERVER_PORT ?? '55424',
    WIREGUARD_SUBNET_CIDR: '24',
    AWG_PROFILE: profileOf(a),
  };
}

export const awgCmd: CommandDef = {
  id: 'awg',
  title: 'Amnezia AWG',
  group: 'install',
  service: 'Amnezia AWG',
  description:
    'Сервер AmneziaWG в контейнере, совместимый с приложением Amnezia. Дополнительный экземпляр нужен для второй версии протокола на том же сервере.',
  params: [
    {
      name: 'AWG_VERSION',
      label: 'Версия AmneziaWG',
      type: 'select',
      default: '3.1',
      options: [
        { value: '3.1', label: '3.1 (последняя)' },
        { value: '2.0', label: '2.0 (клиенты до 3.x, Amnezia VPN 4.8.12+)' },
        { value: '1.0', label: '1.0 (старые клиенты и роутеры)' },
      ],
    },
    {
      name: 'AWG_INSTANCE',
      label: 'Экземпляр',
      type: 'select',
      default: 'main',
      options: [
        { value: 'main', label: 'основной (виден приложению Amnezia)' },
        { value: 'extra', label: 'дополнительный (вторая версия)' },
      ],
    },
    { name: 'AWG_SERVER_PORT', label: 'Порт UDP', type: 'port', default: '55424', required: true },
    {
      name: 'AWG_SUBNET_IP',
      label: 'Подсеть клиентов',
      type: 'string',
      default: '10.8.1.0',
      required: true,
      pattern: '^([0-9]{1,3}\\.){3}0$',
      hint: 'маска /24, не занятая на других серверах',
    },
    {
      name: 'AWG_REPLACE',
      label: 'Если контейнер уже есть',
      type: 'select',
      default: 'stop',
      options: [
        { value: 'stop', label: 'не устанавливать' },
        { value: 'replace', label: 'пересоздать, клиенты будут удалены' },
      ],
    },
  ],
  timeoutSec: 25 * 60,
  // порт - свободный на сервере, подсеть - свободная на всех серверах (lib/awg-alloc.ts)
  liveDefaults: 'awg',
  env: ({ answers }) => genEnv(answers),
  files: ({ answers }) => {
    const e = genEnv(answers);
    const params = generateAwgParams(profileOf(answers));
    const errors = validateAwgParams(params);
    if (errors.length) throw new Error(`параметры AWG не прошли проверку: ${errors.join('; ')}`);
    return {
      [`/opt/amnezia/${e.CONTAINER_NAME}/Dockerfile`]: DOCKERFILE,
      '/tmp/awg-install-start.sh': START_SH.replaceAll(
        '@SUBNET@',
        e.AWG_SUBNET_IP ?? '',
      ).replaceAll('@CIDR@', '24'),
      '/tmp/awg-install-awg0.conf': awgConf(e.AWG_SUBNET_IP ?? '', e.AWG_SERVER_PORT ?? '', params),
    };
  },
  cleanup: ['/tmp/awg-install-start.sh', '/tmp/awg-install-awg0.conf'],
  script: `${PROLOGUE}
${ENSURE_DOCKER}
say "Подготовка сервера"
mkdir -p /opt/amnezia/$CONTAINER_NAME
# Проверки без конвейера "docker ... | grep -q": под pipefail grep выходит на первом совпадении,
# docker дописывает остальные строки в закрытый канал и падает от SIGPIPE - сеть или контейнер
# есть, а проверка говорит "нет" (так падала установка: network already exists).
if ! docker network inspect amnezia-dns-net >/dev/null 2>&1; then
  docker network create --driver bridge --subnet=172.29.172.0/24 --opt com.docker.network.bridge.name=amn0 amnezia-dns-net
fi
if docker container inspect "$CONTAINER_NAME" >/dev/null 2>&1; then
  if [ "$AWG_REPLACE" = "replace" ]; then
    say "Удаляю существующий контейнер $CONTAINER_NAME"
    docker rm -f "$CONTAINER_NAME"
  else
    echo "контейнер $CONTAINER_NAME уже существует: нужно выбрать 'пересоздать' или удалить его вручную" >&2
    exit 3
  fi
fi
say "Сборка образа $CONTAINER_NAME (${IMAGE})"
docker build --no-cache --pull -t "$CONTAINER_NAME" /opt/amnezia/$CONTAINER_NAME
say "Запуск контейнера"
docker run -d --log-driver none --restart always --privileged --cap-add=NET_ADMIN --cap-add=SYS_MODULE \\
  -p "$AWG_SERVER_PORT:$AWG_SERVER_PORT/udp" -v /lib/modules:/lib/modules \\
  --sysctl="net.ipv4.conf.all.src_valid_mark=1" --name "$CONTAINER_NAME" "$CONTAINER_NAME"
docker network connect amnezia-dns-net "$CONTAINER_NAME" || true
say "Ключи, awg0.conf версии $AWG_PROFILE и пустой clientsTable внутри контейнера"
docker exec "$CONTAINER_NAME" mkdir -p /opt/amnezia/awg
PRIV=$(docker exec "$CONTAINER_NAME" awg genkey)
PUB=$(echo "$PRIV" | docker exec -i "$CONTAINER_NAME" awg pubkey)
PSK=$(docker exec "$CONTAINER_NAME" awg genpsk)
printf '%s\\n' "$PRIV" | docker exec -i "$CONTAINER_NAME" sh -c 'cat > /opt/amnezia/awg/wireguard_server_private_key.key'
printf '%s\\n' "$PUB" | docker exec -i "$CONTAINER_NAME" sh -c 'cat > /opt/amnezia/awg/wireguard_server_public_key.key'
printf '%s\\n' "$PSK" | docker exec -i "$CONTAINER_NAME" sh -c 'cat > /opt/amnezia/awg/wireguard_psk.key'
sed "s|@PRIVKEY@|$PRIV|" /tmp/awg-install-awg0.conf | docker exec -i "$CONTAINER_NAME" sh -c 'cat > /opt/amnezia/awg/awg0.conf && chmod 600 /opt/amnezia/awg/awg0.conf /opt/amnezia/awg/wireguard_server_private_key.key'
printf '[]\\n' | docker exec -i "$CONTAINER_NAME" sh -c 'cat > /opt/amnezia/awg/clientsTable && chmod 600 /opt/amnezia/awg/clientsTable'
unset PRIV
say "Скрипт запуска и старт AWG"
docker cp /tmp/awg-install-start.sh "$CONTAINER_NAME:/opt/amnezia/start.sh"
docker exec -d "$CONTAINER_NAME" sh -c "chmod a+x /opt/amnezia/start.sh && /opt/amnezia/start.sh"
say "Firewall сервера"
sysctl -w net.ipv4.ip_forward=1 >/dev/null
sysctl -w net.netfilter.nf_conntrack_max=262144 >/dev/null 2>&1 || true
# Переходы FORWARD -> цепочки docker: только на те, что есть (в docker 28+ цепочки изоляции переименованы).
# Сам docker их и так держит; это страховка на случай, если ufw/iptables их сбросили. Ничего не фатально.
for chain in DOCKER-USER DOCKER-FORWARD DOCKER-ISOLATION-STAGE-1; do
  if iptables -S "$chain" >/dev/null 2>&1; then
    iptables -C FORWARD -j "$chain" >/dev/null 2>&1 || iptables -A FORWARD -j "$chain" || true
  fi
done
if iptables -S DOCKER >/dev/null 2>&1; then
  iptables -C FORWARD -o docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT >/dev/null 2>&1 || iptables -A FORWARD -o docker0 -m conntrack --ctstate RELATED,ESTABLISHED -j ACCEPT || true
  iptables -C FORWARD -o docker0 -j DOCKER >/dev/null 2>&1 || iptables -A FORWARD -o docker0 -j DOCKER || true
  iptables -C FORWARD -i docker0 ! -o docker0 -j ACCEPT >/dev/null 2>&1 || iptables -A FORWARD -i docker0 ! -o docker0 -j ACCEPT || true
  iptables -C FORWARD -i docker0 -o docker0 -j ACCEPT >/dev/null 2>&1 || iptables -A FORWARD -i docker0 -o docker0 -j ACCEPT || true
fi
sleep 3
say "Проверка"
AWG_SHOW=$(docker exec "$CONTAINER_NAME" awg show awg0 2>/dev/null) || { echo "awg0 не поднялся, журнал: docker logs $CONTAINER_NAME" >&2; exit 4; }
head -5 <<<"$AWG_SHOW"
docker exec "$CONTAINER_NAME" test -e /sys/class/net/awg0/tun_flags && echo "Реализация: amneziawg-go" || echo "Реализация: модуль ядра"
say "Сервер AWG $AWG_PROFILE ($CONTAINER_NAME) готов"
echo "Публичный ключ сервера: $PUB"
echo "Порт: $AWG_SERVER_PORT/udp, подсеть $AWG_SUBNET_IP/$WIREGUARD_SUBNET_CIDR"
echo "Клиенты добавляются на вкладке AWG сервера"
`,
  preflight: `if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -qx "$CONTAINER_NAME"; then if [ "$AWG_REPLACE" = "replace" ]; then echo "WARN|контейнер $CONTAINER_NAME будет пересоздан, его клиенты будут удалены"; else echo "FAIL|контейнер $CONTAINER_NAME уже существует"; fi; else echo "OK|контейнера $CONTAINER_NAME нет"; fi
if ss -lun | awk '{print $5}' | grep -q ":$AWG_SERVER_PORT$"; then echo "FAIL|порт $AWG_SERVER_PORT/udp занят"; elif docker ps -a --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -v "^$CONTAINER_NAME " | grep -q ":$AWG_SERVER_PORT->"; then echo "FAIL|порт $AWG_SERVER_PORT/udp занят другим контейнером Docker"; else echo "OK|порт $AWG_SERVER_PORT/udp свободен"; fi
NET="\${AWG_SUBNET_IP%.*}."; BUSY=""
for c in $(docker ps --format '{{.Names}}' 2>/dev/null | grep -E '^amnezia-awg'); do
  [ "$c" = "$CONTAINER_NAME" ] && continue
  docker exec "$c" sh -c 'grep -h "^Address" /opt/amnezia/awg/*.conf 2>/dev/null' | grep -q "= $NET" && BUSY="$BUSY $c"
done
if [ -n "$BUSY" ]; then echo "FAIL|подсеть $AWG_SUBNET_IP/24 занята:$BUSY"; else echo "OK|подсеть $AWG_SUBNET_IP/24 свободна"; fi
if command -v docker >/dev/null 2>&1; then echo "OK|Docker установлен"; else echo "WARN|Docker не установлен, будет установлен"; fi
MOD=$(cat /sys/module/amneziawg/version 2>/dev/null); if [ -n "$MOD" ] && [ "\${MOD%%.*}" -lt 3 ]; then echo "WARN|модуль ядра amneziawg $MOD старше 3.x: будет использован amneziawg-go, он медленнее"; fi`,
  plan: (a) => [
    'Установить Docker, если его нет',
    `Собрать контейнер ${containerOf(a)} с AmneziaWG ${profileOf(a)}`,
    `Запустить AWG на порту ${a.AWG_SERVER_PORT}/udp с подсетью ${a.AWG_SUBNET_IP}/24`,
    'Сгенерировать ключи сервера',
    'Настроить NAT и firewall',
  ],
  after:
    'Клиенты добавляются на вкладке AWG сервера. Основной экземпляр доступен и в приложении Amnezia по SSH.',
};
