import { randomBytes, randomInt } from 'node:crypto';

/**
 * Параметры сервера AmneziaWG по версиям: генерация, как у
 * приложения Amnezia 5.0.3, и проверка правил протокола. Версия - свойство интерфейса:
 * у всех клиентов экземпляра те же S1-S4, H1-H4, HeaderProtectionKey, RandomTrailers.
 */

export type AwgProfile = '3.1' | '2.0' | '1.0';

/** I1 приложения: DNS-подобный ответ (icloud.com), тот же у сервера и клиентов. */
const DEFAULT_I1 =
  '<r 2><b 0x858000010001000000000669636c6f756403636f6d0000010001c00c000100010000105a00044d583737>';

const U31 = 2 ** 31 - 1;

/** Ключ 32 байта в base64 (как awg genkey) - для HeaderProtectionKey. */
function key32(): string {
  const k = randomBytes(32);
  k[0] = (k[0] ?? 0) & 248;
  k[31] = ((k[31] ?? 0) & 127) | 64;
  return k.toString('base64');
}

/** S1-S4, при которых размеры пакетов с мусором не совпадают (148+S1, 92+S2, 64+S3, 32+S4). */
function junkSizes(withS3S4: boolean): { S1: number; S2: number; S3?: number; S4?: number } {
  for (;;) {
    const s = {
      S1: randomInt(15, 150),
      S2: randomInt(15, 150),
      ...(withS3S4 ? { S3: randomInt(1, 64), S4: randomInt(1, 20) } : {}),
    };
    const sizes = [148 + s.S1, 92 + s.S2];
    if (s.S3 !== undefined) sizes.push(64 + s.S3);
    if (s.S4 !== undefined) sizes.push(32 + s.S4);
    if (new Set(sizes).size === sizes.length) return s;
  }
}

/** 2.0: четыре возрастающих непересекающихся диапазона заголовков в [5, 2^31). */
function headerRanges(): string[] {
  for (;;) {
    const pts = Array.from({ length: 8 }, () => randomInt(5, U31)).sort((a, b) => a - b);
    if (new Set(pts).size === 8) return [0, 2, 4, 6].map((i) => `${pts[i]}-${pts[i + 1]}`);
  }
}

/** 1.0: четыре разных одиночных заголовка в [5, 2^31). */
function headerSingles(): string[] {
  for (;;) {
    const h = Array.from({ length: 4 }, () => randomInt(5, U31));
    if (new Set(h).size === 4) return h.map(String);
  }
}

/** Параметры [Interface] для новой установки; ключи - как в конфиге сервера. */
export function generateAwgParams(profile: AwgProfile): Record<string, string> {
  const jc = String(randomInt(4, 7));
  if (profile === '3.1')
    return {
      Jc: jc,
      Jmin: '10',
      Jmax: '50',
      S1: '12',
      S2: '12',
      S3: '12',
      S4: '12',
      H1: '1',
      H2: '2',
      H3: '3',
      H4: '4',
      I1: DEFAULT_I1,
      HeaderProtectionKey: key32(),
      RekeyAfterTime: '100-120',
      RekeyTimeout: '3-7',
      RejectAfterTime: '150-180',
      KeepaliveTimeout: '5-15',
      MaxHandshakeAttempts: '15-20',
      RandomTrailers: 'on',
      DisableCookies: 'on',
    };
  if (profile === '2.0') {
    const s = junkSizes(true);
    const [h1, h2, h3, h4] = headerRanges();
    return {
      Jc: jc,
      Jmin: '10',
      Jmax: '50',
      S1: String(s.S1),
      S2: String(s.S2),
      S3: String(s.S3),
      S4: String(s.S4),
      H1: h1 ?? '',
      H2: h2 ?? '',
      H3: h3 ?? '',
      H4: h4 ?? '',
      I1: DEFAULT_I1,
    };
  }
  const s = junkSizes(false);
  const [h1, h2, h3, h4] = headerSingles();
  return {
    Jc: jc,
    Jmin: '10',
    Jmax: '50',
    S1: String(s.S1),
    S2: String(s.S2),
    H1: h1 ?? '',
    H2: h2 ?? '',
    H3: h3 ?? '',
    H4: h4 ?? '',
  };
}

/** "a-b" или "a" -> [a, b]; null - не число или неверный диапазон. */
function range(v: string): [number, number] | null {
  const m = /^(\d+)(?:-(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  return a <= b ? [a, b] : null;
}

/** Проверка правил протокола; пустой список - параметры годятся. */
export function validateAwgParams(p: Record<string, string>): string[] {
  const errors: string[] = [];
  const num = (k: string) => (p[k] === undefined ? undefined : range(p[k] ?? '')?.[0]);
  for (const k of ['Jc', 'Jmin', 'Jmax', 'S1', 'S2', 'S3', 'S4'])
    if (p[k] !== undefined && !/^\d+$/.test(p[k] ?? '')) errors.push(`${k}: нужно число`);
  const jmin = num('Jmin');
  const jmax = num('Jmax');
  if (jmin !== undefined && jmax !== undefined && jmin > jmax) errors.push('Jmin больше Jmax');
  if (jmax !== undefined && jmax > 1280)
    errors.push('Jmax больше 1280: мусорные пакеты будут фрагментироваться');

  const sizes: [string, number][] = [];
  for (const [k, base] of [
    ['S1', 148],
    ['S2', 92],
    ['S3', 64],
    ['S4', 32],
  ] as const) {
    const v = num(k);
    if (v !== undefined) sizes.push([k, base + v]);
  }
  for (let i = 0; i < sizes.length; i++)
    for (let j = i + 1; j < sizes.length; j++)
      if (sizes[i]?.[1] === sizes[j]?.[1])
        errors.push(`${sizes[i]?.[0]} и ${sizes[j]?.[0]} дают пакеты одного размера`);
  if (p.HeaderProtectionKey)
    for (const k of ['S1', 'S2', 'S3', 'S4'])
      if ((num(k) ?? 0) < 12) errors.push(`${k}: с HeaderProtectionKey нужно не меньше 12`);

  const hs: [string, [number, number]][] = [];
  for (const k of ['H1', 'H2', 'H3', 'H4']) {
    if (p[k] === undefined) continue;
    const r = range(p[k] ?? '');
    if (!r || r[1] > 2 ** 32 - 1) errors.push(`${k}: число или диапазон a-b до 4294967295`);
    else hs.push([k, r]);
  }
  for (let i = 0; i < hs.length; i++)
    for (let j = i + 1; j < hs.length; j++) {
      const a = hs[i];
      const b = hs[j];
      if (a && b && a[1][0] <= b[1][1] && b[1][0] <= a[1][1])
        errors.push(`${a[0]} и ${b[0]} пересекаются`);
    }

  for (const k of [
    'ContentPaddingAddition',
    'RekeyAfterTime',
    'RekeyTimeout',
    'RejectAfterTime',
    'KeepaliveTimeout',
    'MaxHandshakeAttempts',
  ]) {
    if (p[k] === undefined) continue;
    const r = range(p[k] ?? '');
    if (!r || r[1] > 65535) errors.push(`${k}: число или диапазон a-b до 65535`);
  }
  const rekey = p.RekeyAfterTime ? range(p.RekeyAfterTime) : null;
  const reject = p.RejectAfterTime ? range(p.RejectAfterTime) : null;
  if (rekey && reject && reject[0] <= rekey[1])
    errors.push('RejectAfterTime должен быть больше RekeyAfterTime');
  for (const k of ['RandomTrailers', 'DisableCookies'])
    if (p[k] !== undefined && p[k] !== 'on' && p[k] !== 'off')
      errors.push(`${k}: только on или off`);
  return errors;
}
