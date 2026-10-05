import { deflateSync } from 'node:zlib';

/**
 * Клиентские конфиги AmneziaWG: .conf для приложений AmneziaWG
 * строго под версию сервера (лишний ключ ломает импорт на Android и iOS), ключ vpn:// и
 * кадры QR для Amnezia VPN, обычный WireGuard .conf для серверов без обфускации.
 */

export type AwgVersion = '1.0' | '1.5' | '2.0' | '3.0' | '3.1' | 'wg';

const V10 = ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'H1', 'H2', 'H3', 'H4'];
const V15 = [...V10, 'I1', 'I2', 'I3', 'I4', 'I5'];
const V20 = [...V15, 'S3', 'S4'];
const V30 = [
  ...V20,
  'HeaderProtectionKey',
  'ContentPaddingAddition',
  'RekeyAfterTime',
  'RekeyTimeout',
  'RejectAfterTime',
  'KeepaliveTimeout',
  'MaxHandshakeAttempts',
];
const V31 = [...V30, 'RandomTrailers', 'DisableCookies'];
const VERSION_KEYS: Record<AwgVersion, string[]> = {
  wg: [],
  '1.0': V10,
  '1.5': V15,
  '2.0': V20,
  '3.0': V30,
  '3.1': V31,
};
/** Порядок ключей в .conf - как у приложения Amnezia. */
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
  'I1',
  'I2',
  'I3',
  'I4',
  'I5',
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

export interface AwgConfigInput {
  version: AwgVersion;
  /** Параметры [Interface] сервера (I1-I5 могут быть из комментариев). */
  params: { key: string; value: string }[];
  serverPublicKey: string;
  psk: string;
  clientPrivateKey: string;
  clientPublicKey: string;
  /** AllowedIPs клиента на сервере, например "10.8.1.2/32". */
  clientIps: string;
  host: string;
  port: number;
  mtu: number;
  dns: [string, string];
  /** Имя в приложении Amnezia (сервер и клиент). */
  description: string;
  /** Легаси-контейнер amnezia-awg (AWG 1.0 на amnezia-wg). */
  legacy: boolean;
  /** Подсеть сервера из Address, например "10.8.1.0/24". */
  address: string;
}

/** Параметры обфускации, которые идут клиенту: только ключи его версии, в порядке приложения. */
export function clientParams(i: AwgConfigInput): [string, string][] {
  const allowed = new Set(VERSION_KEYS[i.version]);
  const byKey = new Map(i.params.map((p) => [p.key, p.value]));
  return ORDER.filter((k) => allowed.has(k) && (byKey.get(k) ?? '') !== '').map((k) => [
    k,
    byKey.get(k) ?? '',
  ]);
}

const is3x = (v: AwgVersion) => v === '3.0' || v === '3.1';
/** 3.x понимает диапазон; приложение Amnezia даёт 25-35. */
const keepalive = (v: AwgVersion) => (is3x(v) ? '25-35' : '25');
const clientAddress = (ips: string) =>
  ips
    .split(',')
    .map((s) => s.trim())
    .find((s) => /^\d+\.\d+\.\d+\.\d+/.test(s)) ?? ips;

function confText(i: AwgConfigInput, params: [string, string][], ka: string): string {
  const lines = [
    '[Interface]',
    `Address = ${clientAddress(i.clientIps)}`,
    `DNS = ${i.dns.join(', ')}`,
    `PrivateKey = ${i.clientPrivateKey}`,
    `MTU = ${i.mtu}`,
    ...params.map(([k, v]) => `${k} = ${v}`),
    '',
    '[Peer]',
    `PublicKey = ${i.serverPublicKey}`,
    ...(i.psk ? [`PresharedKey = ${i.psk}`] : []),
    'AllowedIPs = 0.0.0.0/0, ::/0',
    `Endpoint = ${i.host}:${i.port}`,
    `PersistentKeepalive = ${ka}`,
  ];
  return `${lines.join('\n')}\n`;
}

/** .conf для приложений AmneziaWG (и awg-quick). */
export function awgClientConf(i: AwgConfigInput): string {
  return confText(i, clientParams(i), keepalive(i.version));
}

/**
 * Годится ли обычный WireGuard: на сервере нет обфускации, которую обязан знать клиент
 * (S1-S4 нулевые, заголовки 1-4, нет защиты заголовков и случайных хвостов).
 */
export function wgCompatible(i: AwgConfigInput): boolean {
  const p = new Map(i.params.map((x) => [x.key, x.value]));
  const zero = (k: string) => !p.get(k) || p.get(k) === '0';
  const header = (k: string, n: string) => !p.get(k) || p.get(k) === n;
  return (
    ['S1', 'S2', 'S3', 'S4'].every(zero) &&
    header('H1', '1') &&
    header('H2', '2') &&
    header('H3', '3') &&
    header('H4', '4') &&
    !p.get('HeaderProtectionKey') &&
    (!p.get('RandomTrailers') || p.get('RandomTrailers') === 'off')
  );
}

/** Обычный WireGuard .conf (без ключей AWG); только если wgCompatible. */
export function wgClientConf(i: AwgConfigInput): string {
  return confText(i, [], '25');
}

/** Qt qCompress: 4 байта длины исходных данных (big-endian) и поток zlib. */
function qCompress(data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  return Buffer.concat([len, deflateSync(data, { level: 8 })]);
}

const b64url = (b: Buffer) => b.toString('base64url');

/** Версия для поля protocol_version приложения (только подпись в его интерфейсе). */
function appProtocolVersion(v: AwgVersion): string | undefined {
  if (is3x(v)) return '3.1';
  if (v === '2.0') return '2';
  if (v === '1.5') return '1.5';
  return undefined;
}

/** JSON подключения для Amnezia VPN, как у приложения 5.0.3 (selfHostedAdminServerConfig). */
export function amneziaJson(i: AwgConfigInput): Record<string, unknown> {
  const params = clientParams(i);
  const conf = awgClientConf(i);
  const ka = keepalive(i.version);
  // все значения - строками: приложение читает last_config через toString(), числа там пустые
  const paramObj = Object.fromEntries(params);
  const lastConfig = {
    ...paramObj,
    config: conf,
    hostName: i.host,
    port: i.port,
    client_ip: clientAddress(i.clientIps).replace(/\/\d+$/, ''),
    client_priv_key: i.clientPrivateKey,
    client_pub_key: i.clientPublicKey,
    clientId: i.clientPublicKey,
    server_pub_key: i.serverPublicKey,
    psk_key: i.psk,
    allowed_ips: ['0.0.0.0/0', '::/0'],
    persistent_keep_alive: ka,
    mtu: String(i.mtu),
  };
  const container = i.legacy ? 'amnezia-awg' : 'amnezia-awg2';
  const version = appProtocolVersion(i.version);
  return {
    containers: [
      {
        container,
        awg: {
          ...paramObj,
          port: String(i.port),
          transport_proto: 'udp',
          ...(version ? { protocol_version: version } : {}),
          subnet_address: i.address.split('/')[0] ?? '',
          last_config: `${JSON.stringify(lastConfig, null, 4)}\n`,
        },
      },
    ],
    defaultContainer: container,
    description: i.description,
    dns1: i.dns[0],
    dns2: i.dns[1],
    hostName: i.host,
  };
}

/**
 * Размер куска для кадра QR. Приложение режет по 850 байт, но такой кадр (QR версии 24)
 * плохо читается с экрана; импорт берёт размер из заголовка кадра (AWP режет по 144).
 */
const QR_CHUNK = 400;

/**
 * Ключ vpn:// и кадры QR для Amnezia VPN. Кадр - QDataStream: qint16 1984, quint8 всего,
 * quint8 номер, QByteArray (quint32 длина и байты); каждый - base64url без "=".
 */
export function amneziaKey(i: AwgConfigInput): { key: string; frames: string[] } {
  const payload = qCompress(Buffer.from(JSON.stringify(amneziaJson(i), null, 4)));
  const total = Math.ceil(payload.length / QR_CHUNK);
  const frames: string[] = [];
  for (let n = 0; n < total; n++) {
    const part = payload.subarray(n * QR_CHUNK, (n + 1) * QR_CHUNK);
    const head = Buffer.alloc(8);
    head.writeInt16BE(1984, 0);
    head.writeUInt8(total, 2);
    head.writeUInt8(n, 3);
    head.writeUInt32BE(part.length, 4);
    frames.push(b64url(Buffer.concat([head, part])));
  }
  return { key: `vpn://${b64url(payload)}`, frames };
}

const regionRu = (() => {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' });
  } catch {
    return null;
  }
})();

/** Флаг страны из кода ISO: Happ показывает первый флаг в подписи как иконку сервера. */
export function countryFlag(iso: string): string {
  if (!/^[A-Z]{2}$/.test(iso)) return '';
  return String.fromCodePoint(...[...iso].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/**
 * Как подключение называется у клиента - везде (подписка, AWG, личная страница): "(флаг) Страна
 * :: Хостинг" (в Amnezia VPN - из description ключа vpn://), у дополнительного экземпляра AWG -
 * ещё и версия ("... :: AWG 2.0"). Имя клиента туда не попадает. Без хостинга - имя сервера в
 * панели. file - имя .conf, оно же имя туннеля в AmneziaWG: Android принимает только
 * [A-Za-z0-9_=+.-] и до 15 символов ("SE-Hoster", "SE-Hoster-2.0").
 */
export function awgTunnelNames(o: {
  provider: string;
  country: string;
  serverName: string;
  /** Версия дополнительного экземпляра; у основного не передаётся. */
  version?: AwgVersion | undefined;
}): { title: string; file: string } {
  const iso = /^[A-Z]{2}$/.test(o.country) ? o.country : '';
  const country = iso ? (regionRu?.of(iso) ?? iso) : o.country.trim();
  const host = o.provider.trim() || o.serverName.trim();
  const ver = o.version ? (o.version === 'wg' ? 'WireGuard' : `AWG ${o.version}`) : '';
  const place = [countryFlag(iso), country].filter(Boolean).join(' ');
  const title = [place, host, ver].filter(Boolean).join(' :: ');
  // "SE-Hoster-2.0": хостинг укорачивается так, чтобы с кодом страны и версией влезть в 15
  const tag = o.version === 'wg' ? 'wg' : (o.version ?? '');
  const fixed = [iso, tag].filter(Boolean);
  const room = 15 - fixed.join('').length - fixed.length;
  const base = host.replace(/[^A-Za-z0-9_=+.-]/g, '').slice(0, Math.max(0, room));
  const file = [iso, base, tag].filter(Boolean).join('-');
  return { title, file: file || 'awg' };
}
