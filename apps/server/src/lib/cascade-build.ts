import { isIP } from 'node:net';
import type { CascadeMode } from '@vps/protocol';
import { type Fingerprint, buildInbound } from './xui-new-inbound.js';

/**
 * Каскад VLESS в шаблоне Xray входа: свои outbound-ы и правила маршрутизации. Панель меняет в
 * шаблоне только то, что помечено префиксом (тег outbound-а, ruleTag правила), остальное -
 * правила владельца, WARP, "Базовые соединения" - не трогает.
 */
export const CASCADE_PREFIX = 'vp-cascade-';
/** Свой freedom-выход каскадов: не зависим от того, как владелец назвал свой direct. */
export const CASCADE_DIRECT = `${CASCADE_PREFIX}direct`;
export const CASCADE_BLOCKED = `${CASCADE_PREFIX}blocked`;

export const outboundTag = (id: string) => `${CASCADE_PREFIX}${id}`;
/** Свой inbound-тег каскада: трафик входа заводится на него loopback-ом (см. buildRules). */
const innerTag = (id: string) => `${CASCADE_PREFIX}${id}-in`;
const loopTag = (id: string) => `${CASCADE_PREFIX}${id}-lb`;
const ruleTag = (id: string, part: string) => `${CASCADE_PREFIX}${id}-${part}`;
const own = (tag: unknown) => typeof tag === 'string' && tag.startsWith(CASCADE_PREFIX);

/** Параметры подключения к RAW Reality inbound-у выхода от имени служебного клиента. */
export interface ExitParams {
  address: string;
  port: number;
  uuid: string;
  publicKey: string;
  shortId: string;
  sni: string;
  fingerprint: string;
}

/** Socks-inbound Telegram каскада: в него ходит MTProxyL входа (upstream socks5). */
export const telegramTag = (id: string) => `${CASCADE_PREFIX}${id}-tg`;

/**
 * Вход для MTProxyL входа: socks5 без пароля только на 127.0.0.1 (снаружи недоступен, port-sync
 * его не открывает). Inbound - в шаблоне, а не в базе 3X-UI: его не видно в списке inbound-ов и
 * в него не попадают клиенты.
 */
export function telegramInbound(id: string, port: number): Record<string, unknown> {
  return {
    tag: telegramTag(id),
    listen: '127.0.0.1',
    port,
    protocol: 'socks',
    settings: { auth: 'noauth', udp: false },
  };
}

/**
 * Правило Telegram каскада: весь трафик socks-inbound-а - на выход, без режимов и списков
 * (адреса Telegram зарубежные). Каскад не собрать - в блок, а не к Telegram с адреса входа; из
 * маршрутов MTProxyL такой каскад панель убирает сама (tgUpstreams).
 */
export function telegramRule(id: string, ok: boolean): Record<string, unknown> {
  return {
    type: 'field',
    ruleTag: ruleTag(id, 'tg'),
    inboundTag: [telegramTag(id)],
    outboundTag: ok ? outboundTag(id) : CASCADE_BLOCKED,
  };
}

/** Loopback каскада: возвращает трафик inbound-а входа в маршрутизацию под своим тегом. */
export function loopOutbound(id: string): Record<string, unknown> {
  return { tag: loopTag(id), protocol: 'loopback', settings: { inboundTag: innerTag(id) } };
}

export function buildOutbound(id: string, p: ExitParams): Record<string, unknown> {
  return {
    tag: outboundTag(id),
    protocol: 'vless',
    settings: {
      vnext: [
        {
          address: p.address,
          port: p.port,
          users: [{ id: p.uuid, encryption: 'none', flow: 'xtls-rprx-vision' }],
        },
      ],
    },
    streamSettings: {
      network: 'tcp',
      security: 'reality',
      realitySettings: {
        serverName: p.sni,
        fingerprint: p.fingerprint || 'chrome',
        publicKey: p.publicKey,
        shortId: p.shortId,
        spiderX: '/',
      },
    },
  };
}

/** Свои выходы "напрямую" и "блок": private-адреса закрыты, как у direct 3X-UI по умолчанию. */
export const SERVICE_OUTBOUNDS: Record<string, unknown>[] = [
  {
    tag: CASCADE_DIRECT,
    protocol: 'freedom',
    settings: { finalRules: [{ action: 'block', ip: ['geoip:private'] }, { action: 'allow' }] },
  },
  { tag: CASCADE_BLOCKED, protocol: 'blackhole', settings: {} },
];

/** Российские домены (TLD и категория geosite.dat) - есть в любой установке 3X-UI. */
const RU_DOMAINS = ['domain:ru', 'domain:su', 'domain:xn--p1ai', 'geosite:category-ru'];
const RU_ONLY_INSIDE = 'ext:geosite_RU.dat:ru-available-only-inside';
const RU_BLOCKED_DOMAINS = 'ext:geosite_RU.dat:ru-blocked';
const RU_BLOCKED_IPS = 'ext:geoip_RU.dat:ru-blocked';

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i;
const PREFIXED = /^(domain|full|keyword|geosite|ext):\S+$/;

/** IP или подсеть с маской в своих границах. */
function ipOrCidr(s: string): boolean {
  const [addr = '', mask, extra] = s.split('/');
  if (extra !== undefined) return false;
  const v = isIP(addr);
  if (!v) return false;
  if (mask === undefined) return true;
  if (!/^\d{1,3}$/.test(mask)) return false;
  return Number(mask) <= (v === 4 ? 32 : 128);
}

/** regexp: - то, что примет и Go (RE2): без обратных ссылок и просмотра вперёд/назад. */
function goodRegexp(body: string): boolean {
  if (!body || /\(\?[=!<]|\\[1-9]/.test(body)) return false;
  try {
    new RegExp(body);
    return true;
  } catch {
    return false;
  }
}

/**
 * Свой список каскада: строки - домены (example.com - с поддоменами), с префиксом xray
 * (full:, keyword:, regexp:, geosite:, ext:файл:категория), IP, подсети, geoip:XX. Неверные
 * строки - в invalid. Есть ли категории geosite/geoip на сервере, проверяет 3X-UI
 * (xray/geodata/validate) до записи: неверное правило останавливает весь Xray входа.
 */
export function parseList(lines: readonly string[]): {
  domains: string[];
  ips: string[];
  invalid: string[];
} {
  const domains: string[] = [];
  const ips: string[] = [];
  const invalid: string[] = [];
  for (const raw of lines) {
    const s = raw.trim();
    if (!s || s.startsWith('#')) continue;
    if (/^geoip:[a-z!-]+$/i.test(s)) ips.push(s.toLowerCase());
    else if (/^ext:[\w.-]+\.dat:[\w!-]+$/.test(s) && /geoip/i.test(s.split(':')[1] ?? ''))
      ips.push(s);
    else if (ipOrCidr(s)) ips.push(s);
    else if (s.startsWith('regexp:')) (goodRegexp(s.slice(7)) ? domains : invalid).push(s);
    else if (PREFIXED.test(s)) domains.push(s);
    else if (DOMAIN.test(s)) domains.push(`domain:${s.toLowerCase()}`);
    else invalid.push(s);
  }
  return { domains: [...new Set(domains)], ips: [...new Set(ips)], invalid };
}

export interface CascadeRules {
  id: string;
  mode: CascadeMode;
  inboundTag: string;
  directList: string[];
  exitList: string[];
  blockQuic: boolean;
  /** На входе есть geosite_RU.dat и geoip_RU.dat (списки заблокированного). */
  geoRu: boolean;
}

/**
 * Правила каскада. Первое - трафик inbound-а входа в loopback каскада; остальные стоят на своём
 * inbound-теге loopback-а, а не на теге inbound-а входа: при удалении inbound-а 3X-UI убирает его
 * тег из правил, и правило с другими условиями стало бы общим для всего сервера, а так пропадает
 * только первое правило. Дальше по порядку (первое совпавшее решает): private-адреса и торренты в
 * блок, QUIC в блок, свои списки "через выход" и "напрямую", затем режим. Заблокированное в
 * России стоит выше российского: российские сервисы на .ru бывают в списке блокировок.
 */
export function buildRules(c: CascadeRules): Record<string, unknown>[] {
  const ob = outboundTag(c.id);
  const out: Record<string, unknown>[] = [
    {
      type: 'field',
      ruleTag: ruleTag(c.id, 'entry'),
      inboundTag: [c.inboundTag],
      outboundTag: loopTag(c.id),
    },
  ];
  const rule = (part: string, outbound: string, match: Record<string, unknown>) =>
    out.push({
      type: 'field',
      ruleTag: ruleTag(c.id, part),
      inboundTag: [innerTag(c.id)],
      ...match,
      outboundTag: outbound,
    });
  rule('private', CASCADE_BLOCKED, { ip: ['geoip:private'] });
  rule('torrent', CASCADE_BLOCKED, { protocol: ['bittorrent'] });
  if (c.blockQuic) rule('quic', CASCADE_BLOCKED, { network: 'udp', port: '443' });
  const ex = parseList(c.exitList);
  if (ex.domains.length) rule('exit-domains', ob, { domain: ex.domains });
  if (ex.ips.length) rule('exit-ips', ob, { ip: ex.ips });
  const dir = parseList(c.directList);
  if (dir.domains.length) rule('direct-domains', CASCADE_DIRECT, { domain: dir.domains });
  if (dir.ips.length) rule('direct-ips', CASCADE_DIRECT, { ip: dir.ips });
  if (c.mode === 'ru-direct') {
    if (c.geoRu) rule('blocked-domains', ob, { domain: [RU_BLOCKED_DOMAINS] });
    rule('ru-domains', CASCADE_DIRECT, {
      domain: c.geoRu ? [...RU_DOMAINS, RU_ONLY_INSIDE] : RU_DOMAINS,
    });
    rule('ru-ips', CASCADE_DIRECT, { ip: ['geoip:ru'] });
    rule('rest', ob, {});
  } else if (c.mode === 'blocked') {
    if (!c.geoRu) throw new Error('на входе нет geosite_RU.dat и geoip_RU.dat: режим недоступен');
    rule('blocked-domains', ob, { domain: [RU_BLOCKED_DOMAINS] });
    rule('blocked-ips', ob, { ip: [RU_BLOCKED_IPS] });
    rule('rest', CASCADE_DIRECT, {});
  } else rule('rest', ob, {});
  return out;
}

/**
 * Каскад, который сейчас не собрать (нет inbound-а выхода, ошибка правил): трафик его inbound-а
 * - в блок, а не напрямую с входа мимо выхода.
 */
export function blockedRules(id: string, inboundTag: string): Record<string, unknown>[] {
  return [
    {
      type: 'field',
      ruleTag: ruleTag(id, 'entry'),
      inboundTag: [inboundTag],
      outboundTag: CASCADE_BLOCKED,
    },
  ];
}

type Template = Record<string, unknown> & {
  inbounds?: Record<string, unknown>[];
  outbounds?: Record<string, unknown>[];
  routing?: Record<string, unknown> & { rules?: Record<string, unknown>[] };
};

/**
 * Шаблон Xray с каскадами входа: свои inbound-ы (socks для Telegram), outbound-ы и правила
 * заменяются целиком, чужое остаётся на месте. Свои правила - сразу после правил api (до правил
 * владельца: иначе его "Базовые соединения" перехватят трафик каскада). Каскадов нет - своего в
 * шаблоне не остаётся.
 */
export function mergeTemplate(
  template: Template,
  outbounds: Record<string, unknown>[],
  rules: Record<string, unknown>[],
  inbounds: Record<string, unknown>[] = [],
): Template {
  const keepIn = (template.inbounds ?? []).filter((i) => !own(i.tag));
  const keepOut = (template.outbounds ?? []).filter((o) => !own(o.tag));
  const routing = { ...(template.routing ?? {}) };
  const keepRules = (routing.rules ?? []).filter((r) => !own(r.ruleTag));
  let at = 0;
  keepRules.forEach((r, i) => {
    if (r.outboundTag === 'api' || (Array.isArray(r.inboundTag) && r.inboundTag.includes('api')))
      at = i + 1;
  });
  const ownOut = outbounds.length || rules.length ? [...SERVICE_OUTBOUNDS, ...outbounds] : [];
  return {
    ...template,
    ...(template.inbounds || inbounds.length ? { inbounds: [...keepIn, ...inbounds] } : {}),
    outbounds: [...keepOut, ...ownOut],
    routing: { ...routing, rules: [...keepRules.slice(0, at), ...rules, ...keepRules.slice(at)] },
  };
}

/** JSON с ключами по алфавиту: 3X-UI при своих перезаписях шаблона сортирует ключи. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object')
    return `{${Object.keys(v)
      .sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  return JSON.stringify(v);
}

/** Свои части шаблона (inbound-ы, outbound-ы и правила каскадов) - для сравнения "уже стоит". */
export function ownParts(template: Template): string {
  return canonical({
    i: (template.inbounds ?? []).filter((i) => own(i.tag)),
    o: (template.outbounds ?? []).filter((o) => own(o.tag)),
    r: (template.routing?.rules ?? []).filter((r) => own(r.ruleTag)),
  });
}

/** Свои части шаблона без служебных outbound-ов - для отката на свежий шаблон. */
export function ownOf(template: Template): {
  inbounds: Record<string, unknown>[];
  outbounds: Record<string, unknown>[];
  rules: Record<string, unknown>[];
} {
  const service = new Set(SERVICE_OUTBOUNDS.map((o) => o.tag));
  return {
    inbounds: (template.inbounds ?? []).filter((i) => own(i.tag)),
    outbounds: (template.outbounds ?? []).filter((o) => own(o.tag) && !service.has(o.tag)),
    rules: (template.routing?.rules ?? []).filter((r) => own(r.ruleTag)),
  };
}

/**
 * Inbound входа: RAW Reality (как добавляемые из панели) со sniffing - без него доменные правила
 * не срабатывают; routeOnly - домен только для маршрута, адрес назначения не подменяется.
 */
export function entryInbound(p: {
  port: number;
  remark: string;
  target: string;
  serverNames: string[];
  fingerprint: Fingerprint;
}): Record<string, unknown> {
  return {
    ...buildInbound({ kind: 'raw', ...p }),
    sniffing: JSON.stringify({
      enabled: true,
      destOverride: ['http', 'tls', 'quic'],
      routeOnly: true,
    }),
  };
}

/** Подпись inbound-а входа в 3X-UI. */
export const entryRemark = (exitName: string) => `\u2192 ${exitName}`.slice(0, 100);

/** Подпись входа прежнего вида ("-> выход"): переименовывается сверкой. */
export const oldEntryRemark = (remark: string) =>
  remark.startsWith('-> ') ? entryRemark(remark.slice(3)) : null;
