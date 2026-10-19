import { isIPv4 } from 'node:net';
import type { RealityPreset, RealityRejected } from '@vps/protocol';
import type { XuiCall, XuiFormCall } from './xui-api.js';
import { unwrap } from './xui-api.js';
import { type RealityScanRow, pickTargets } from './xui-new-inbound.js';

/**
 * Подбор цели Reality: 3X-UI проверяет кандидатов с самого сервера (TLS 1.3, h2, X25519,
 * сертификат, задержка) - server/scanRealityTargets с формой targets. Кандидаты - готовые
 * списки (зарубежные и российские сайты), адреса рядом с сервером (его /24, как RealiTLScanner)
 * или свои адреса владельца.
 */

/** Зарубежные сайты: список 3X-UI и похожие крупные сайты с TLS 1.3 и h2. */
const FOREIGN = [
  'www.cloudflare.com',
  'www.microsoft.com',
  'www.amazon.com',
  'aws.amazon.com',
  'www.samsung.com',
  'www.nvidia.com',
  'www.amd.com',
  'www.intel.com',
  'www.sony.com',
  'dl.google.com',
  'www.apple.com',
  'www.icloud.com',
  'www.mozilla.org',
  'www.oracle.com',
  'www.cisco.com',
  'www.ibm.com',
  'www.hp.com',
  'www.dell.com',
  'www.lenovo.com',
  'www.asus.com',
  'www.logitech.com',
  'www.adobe.com',
  'www.booking.com',
  'www.ikea.com',
  'www.bmw.com',
  'www.siemens.com',
  'www.philips.com',
  'www.lg.com',
  'www.speedtest.net',
  'www.tesla.com',
];

/** Российские сайты: для входа каскада на российском адресе. */
const RU = [
  'ya.ru',
  'yandex.ru',
  'dzen.ru',
  'mail.ru',
  'vk.com',
  'ok.ru',
  'www.ozon.ru',
  'www.wildberries.ru',
  'www.avito.ru',
  'www.kinopoisk.ru',
  'rutube.ru',
  'www.gosuslugi.ru',
  'www.sberbank.ru',
  'www.tbank.ru',
  'www.vtb.ru',
  'alfabank.ru',
  'www.mos.ru',
  'www.rzd.ru',
  'www.aeroflot.ru',
  'www.mvideo.ru',
  'www.dns-shop.ru',
  'www.lamoda.ru',
  'hh.ru',
  'www.2gis.ru',
  'ria.ru',
  'www.rbc.ru',
  'lenta.ru',
  'www.kp.ru',
  'auto.ru',
  'market.yandex.ru',
  'www.mts.ru',
  'moskva.megafon.ru',
  'www.tele2.ru',
  'www.perekrestok.ru',
  'www.vkusvill.ru',
  'www.citilink.ru',
  'www.sportmaster.ru',
  'www.ivi.ru',
  'www.litres.ru',
  'habr.com',
];

export const PRESET_TARGETS: Record<Exclude<RealityPreset, 'nearby'>, string[]> = {
  foreign: FOREIGN.map((h) => `${h}:443`),
  ru: RU.map((h) => `${h}:443`),
};

/** Своих адресов - не больше: проверка идёт одним запросом к 3X-UI, у агента на него 30 с. */
export const MAX_CUSTOM = 30;

/**
 * Свой адрес: имя или IPv4, порт по умолчанию 443 (https:// и путь отбрасываются). Неверный -
 * null.
 */
export function normalizeTarget(raw: string): string | null {
  const s = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '');
  if (!s) return null;
  const m = /^([a-z0-9.-]+?)(?::(\d{1,5}))?$/.exec(s);
  if (!m) return null;
  const host = m[1] ?? '';
  const port = Number(m[2] ?? 443);
  if (port < 1 || port > 65535) return null;
  if (!isIPv4(host) && !/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(host)) return null;
  return `${host}:${port}`;
}

/** Причина отказа 3X-UI - коротко по-русски. */
export function rejectReason(r: RealityScanRow & { reason?: string }): string {
  const why = String(r.reason ?? '');
  if (/TLS 1\.3/.test(why)) return 'нет TLS 1.3';
  if (/HTTP\/2|h2/.test(why)) return 'нет HTTP/2';
  if (/X25519/.test(why)) return 'нет X25519';
  if (/not trusted|certificate|domain in certificate/.test(why)) return 'сертификат не подходит';
  if (/connection failed|timeout|refused|no such host|handshake/i.test(why)) return 'не отвечает';
  if (/private|internal/i.test(why)) return 'внутренний адрес';
  if (r.feasible && !(r.serverNames ?? []).length) return 'нет подходящих имён';
  return why || 'не подходит';
}

export interface ScanDeps {
  /** Вызов формой (новый агент); без него - только список 3X-UI по умолчанию. */
  form: XuiFormCall | null;
  api: XuiCall;
  /** Адрес сервера: для "рядом с сервером" и чтобы не предложить сам сервер. */
  host: string;
}

async function scan(d: ScanDeps, targets: string[] | null): Promise<RealityScanRow[]> {
  const res =
    targets && d.form
      ? await d.form('POST', 'server/scanRealityTargets', { targets: targets.join(',') })
      : await d.api('POST', 'server/scanRealityTargets');
  const rows = unwrap(res, 'server/scanRealityTargets');
  return Array.isArray(rows) ? (rows as RealityScanRow[]) : [];
}

/**
 * Подбор: preset - готовый список или адреса рядом с сервером, targets - свои адреса (тогда в
 * ответе и отказы с причинами). Старый агент без вызова формой - только список 3X-UI.
 */
export async function realityScan(
  d: ScanDeps,
  req: { preset?: RealityPreset | undefined; targets?: string[] | undefined },
): Promise<{ targets: ReturnType<typeof pickTargets>; rejected: RealityRejected[] }> {
  const fail = (m: string) => Object.assign(new Error(m), { statusCode: 400 });
  if (req.targets?.length) {
    if (!d.form)
      throw Object.assign(new Error('агент устарел: нужно обновить агент'), { statusCode: 409 });
    const list: string[] = [];
    const bad: RealityRejected[] = [];
    for (const raw of req.targets.slice(0, MAX_CUSTOM)) {
      const t = normalizeTarget(raw);
      if (t) list.includes(t) || list.push(t);
      else if (raw.trim()) bad.push({ target: raw.trim(), reason: 'неверный адрес' });
    }
    if (!list.length) return { targets: [], rejected: bad };
    const rows = await scan(d, list);
    const ok = pickTargets(rows, MAX_CUSTOM);
    const rejected = [
      ...bad,
      ...rows
        .filter((r) => r.target && !ok.some((o) => o.target === r.target))
        .map((r) => ({ target: String(r.target), reason: rejectReason(r) })),
    ];
    return { targets: ok, rejected };
  }
  const preset = req.preset ?? 'foreign';
  if (preset === 'nearby') {
    if (!d.form)
      throw Object.assign(new Error('агент устарел: нужно обновить агент'), { statusCode: 409 });
    if (!isIPv4(d.host)) throw fail('адрес сервера - не IPv4: соседние адреса не подобрать');
    const net = d.host.split('.').slice(0, 3).join('.');
    // /24 двумя запросами: 256 адресов за раз не успевают за таймаут агента
    const rows = [
      ...(await scan(d, [`${net}.0/25`])),
      ...(await scan(d, [`${net}.128/25`])),
    ].filter((r) => !String(r.target ?? '').startsWith(`${d.host}:`));
    return { targets: pickTargets(rows, 8), rejected: [] };
  }
  const rows = await scan(d, d.form ? PRESET_TARGETS[preset] : null);
  return { targets: pickTargets(rows), rejected: [] };
}
