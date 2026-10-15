import { generateKeyPairSync, randomBytes, randomInt } from 'node:crypto';
import type { Listener } from '@vps/protocol';
import { parseJson } from './xui-api.js';

/**
 * Новые inbound-ы VLESS с Reality для 3X-UI: RAW (TCP + Vision) и XHTTP. Настройки - те, что
 * работают на серверах сейчас; меняются тип, порт, цель Reality, подпись и fingerprint, ключи
 * и shortIds каждый раз новые. Тело - для POST inbounds/add (settings, streamSettings и
 * sniffing 3X-UI хранит строками JSON).
 */
export type NewInboundKind = 'raw' | 'xhttp';

export const KIND_TITLE: Record<NewInboundKind, string> = { raw: 'RAW', xhttp: 'XHTTP' };
/** Подпись по умолчанию: такие же, как у inbound-ов, заведённых руками. */
export const KIND_REMARK: Record<NewInboundKind, string> = { raw: 'VLESS', xhttp: 'XHTTP' };
/** XHTTP - на 8443: 443 на серверах занят другими сервисами. */
export const XHTTP_PORT = 8443;
/** Диапазон случайного порта RAW. */
export const RANDOM_PORT_RANGE: [number, number] = [10000, 60000];
export const FINGERPRINTS = ['firefox', 'chrome', 'safari', 'edge', 'ios', 'android'] as const;
export type Fingerprint = (typeof FINGERPRINTS)[number];
/** Имён Reality в inbound-е - не больше (у нынешних 16). */
export const MAX_SERVER_NAMES = 16;

export interface NewInboundParams {
  kind: NewInboundKind;
  port: number;
  remark: string;
  /** host:port цели Reality. */
  target: string;
  serverNames: string[];
  fingerprint: Fingerprint;
}

/** Пара ключей Reality (x25519) в виде, который ждёт Xray: base64url без выравнивания. */
export function realityKeys(): { privateKey: string; publicKey: string } {
  const { privateKey, publicKey } = generateKeyPairSync('x25519');
  const priv = privateKey.export({ format: 'jwk' }).d;
  const pub = publicKey.export({ format: 'jwk' }).x;
  if (!priv || !pub) throw new Error('не удалось создать ключи Reality');
  return { privateKey: priv, publicKey: pub };
}

/** 8 shortIds: hex длиной 2, 4 ... 16 в случайном порядке (как раздаёт 3X-UI). */
export function shortIds(): string[] {
  const out = [2, 4, 6, 8, 10, 12, 14, 16].map((n) => randomBytes(n / 2).toString('hex'));
  for (let i = out.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
}

/**
 * Имена YouTube (и его доменов картинок и видео) в Reality не берём: в России их замедляют, и
 * соединение с таким SNI может замедлиться вместе с ними.
 */
export function isYoutubeName(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  return (
    n.includes('youtube') ||
    /(^|\.)(youtu\.be|yt\.be|ytimg\.com|googlevideo\.com|ggpht\.com)$/.test(n)
  );
}

/** Имена Reality из сертификата цели: без wildcard, IP, повторов и YouTube, не больше 16. */
export function realityNames(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of names) {
    const n = raw.trim().toLowerCase();
    if (!n || n.includes('*') || !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(n) || isYoutubeName(n)) continue;
    if (!out.includes(n)) out.push(n);
    if (out.length >= MAX_SERVER_NAMES) break;
  }
  return out;
}

/** Результат server/scanRealityTargets 3X-UI (нужные поля). */
export interface RealityScanRow {
  target?: string;
  host?: string;
  feasible?: boolean;
  serverNames?: string[] | null;
  latencyMs?: number;
  certIssuer?: string;
  reason?: string;
}

/** Цель Reality для окна: адрес, имена (уже без YouTube), задержка с сервера. */
export interface RealityChoice {
  target: string;
  serverNames: string[];
  latencyMs: number;
  issuer: string;
}

/**
 * Подходящие цели из скана: feasible, с именами после фильтра (цель, у которой остались одни
 * имена YouTube, не подходит), по задержке; не больше limit.
 */
export function pickTargets(rows: readonly RealityScanRow[], limit = 5): RealityChoice[] {
  const out: RealityChoice[] = [];
  const sorted = [...rows]
    .filter((r) => r.feasible && r.target)
    .sort((a, b) => (a.latencyMs ?? 1e9) - (b.latencyMs ?? 1e9));
  for (const r of sorted) {
    const host = String(r.host ?? '').toLowerCase();
    let names = realityNames(r.serverNames ?? []);
    // имя, с которым проверяли, - первым: им же проверяет доступность из России
    if (host && names.includes(host)) names = [host, ...names.filter((n) => n !== host)];
    if (!names.length || out.some((o) => o.target === r.target)) continue;
    out.push({
      target: String(r.target),
      serverNames: names,
      latencyMs: Math.max(0, Math.round(r.latencyMs ?? 0)),
      issuer: String(r.certIssuer ?? ''),
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Цель Reality уже стоящего inbound-а (для "Как у inbound X"); имена - тем же фильтром. */
export interface SameAs {
  id: number;
  remark: string;
  target: string;
  serverNames: string[];
  fingerprint: string;
}

export function realityOfInbounds(list: readonly Record<string, unknown>[]): SameAs[] {
  const out: SameAs[] = [];
  for (const i of list) {
    if (Number(i.nodeId ?? i.node_id ?? 0)) continue;
    const st = parseJson(i.streamSettings);
    if (st.security !== 'reality') continue;
    const rs = parseJson(st.realitySettings);
    const target = String(rs.target ?? rs.dest ?? '');
    const names = realityNames((rs.serverNames as string[] | undefined) ?? []);
    if (!target || !names.length) continue;
    out.push({
      id: Number(i.id),
      remark: String(i.remark ?? ''),
      target,
      serverNames: names,
      fingerprint: String(parseJson(rs.settings).fingerprint ?? ''),
    });
  }
  return out;
}

/**
 * Чем занят порт: другим inbound-ом или процессом сервера (по отчёту агента). Для нового
 * inbound-а занят любой слушающий TCP-порт, в том числе внутренние порты самого xray (API,
 * метрики): inbound на занятом порту останавливает весь Xray. null - свободен.
 */
export function portBusy(
  port: number,
  inbounds: readonly Record<string, unknown>[],
  listeners: readonly Listener[],
): string | null {
  const other = inbounds.find((x) => Number(x.port) === port);
  if (other)
    return `порт ${port} уже занят inbound \u00ab${String(other.remark || `#${other.id}`)}\u00bb`;
  const l = listeners.find((x) => x.proto === 'tcp' && x.port === port);
  if (l) return `порт ${port} занят: ${l.process || 'другой процесс'}`;
  return null;
}

/** Случайный свободный порт из RANDOM_PORT_RANGE (busy - занят ли). */
export function randomFreePort(busy: (port: number) => boolean, rnd = randomInt): number {
  const [lo, hi] = RANDOM_PORT_RANGE;
  for (let i = 0; i < 200; i++) {
    const p = rnd(lo, hi + 1);
    if (!busy(p)) return p;
  }
  for (let p = lo; p <= hi; p++) if (!busy(p)) return p;
  throw new Error('нет свободного порта');
}

/** Подпись без повтора: "XHTTP", занята - "XHTTP 2", "XHTTP 3"... */
export function freeRemark(base: string, taken: readonly string[]): string {
  const set = new Set(taken.map((t) => t.trim().toLowerCase()));
  if (!set.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) if (!set.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
}

/** Тело inbounds/add. Клиентов нет: их заводит синхронизация глобальных клиентов. */
export function buildInbound(
  p: NewInboundParams,
  keys = realityKeys(),
  ids = shortIds(),
): Record<string, unknown> {
  const reality = {
    show: false,
    xver: 0,
    target: p.target,
    serverNames: p.serverNames,
    privateKey: keys.privateKey,
    minClientVer: '',
    maxClientVer: '',
    maxTimediff: 0,
    shortIds: ids,
    mldsa65Seed: '',
    settings: {
      publicKey: keys.publicKey,
      fingerprint: p.fingerprint,
      serverName: '',
      spiderX: '/',
      mldsa65Verify: '',
    },
  };
  const raw = p.kind === 'raw';
  const settings = raw
    ? { clients: [], decryption: 'none', encryption: 'none', testseed: [900, 500, 900, 256] }
    : { clients: [], decryption: 'none', encryption: 'none' };
  const stream = raw
    ? {
        network: 'tcp',
        tcpSettings: { acceptProxyProtocol: false, header: { type: 'none' } },
        security: 'reality',
        realitySettings: reality,
      }
    : {
        network: 'xhttp',
        xhttpSettings: {
          path: '/',
          host: '',
          mode: 'auto',
          xPaddingBytes: '100-1000',
          scMaxBufferedPosts: 30,
          scStreamUpServerSecs: '20-80',
        },
        security: 'reality',
        realitySettings: reality,
        sockopt: { tcpFastOpen: true, tcpcongestion: 'bbr' },
      };
  const sniffing = raw
    ? { enabled: false }
    : { enabled: true, destOverride: ['http', 'tls', 'quic', 'fakedns'] };
  return {
    up: 0,
    down: 0,
    total: 0,
    remark: p.remark,
    enable: true,
    expiryTime: 0,
    trafficReset: 'never',
    listen: '',
    port: p.port,
    protocol: 'vless',
    settings: JSON.stringify(settings),
    streamSettings: JSON.stringify(stream),
    sniffing: JSON.stringify(sniffing),
  };
}
