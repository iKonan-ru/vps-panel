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

const IPV4 = /^(\d{1,3})(\.\d{1,3}){3}(\/\d{1,2})?$/;
const IPV6 = /^[0-9a-f:]+:[0-9a-f:]*(\/\d{1,3})?$/i;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z0-9-]{2,}$/i;
const PREFIXED = /^(domain|full|keyword|regexp|geosite|ext):\S+$/;

/**
 * Свой список каскада: строки - домены (example.com - с поддоменами), с префиксом xray
 * (full:, keyword:, regexp:, geosite:, ext:файл:категория), IP, подсети, geoip:XX. Неверные
 * строки - в invalid (окно их показывает, в шаблон не попадают).
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
    if (s.startsWith('geoip:') && /^geoip:[a-z!-]+$/i.test(s)) ips.push(s.toLowerCase());
    else if (IPV4.test(s) || IPV6.test(s)) ips.push(s);
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
 * Правила каскада по порядку (первое совпавшее решает): QUIC в блок, свои списки "через выход"
 * и "напрямую", затем режим. Доменные правила "через выход" стоят выше российских: резолвер
 * провайдера отдаёт для заблокированного домена российский адрес-заглушку, и по geoip он ушёл
 * бы напрямую.
 */
export function buildRules(c: CascadeRules): Record<string, unknown>[] {
  const ob = outboundTag(c.id);
  const out: Record<string, unknown>[] = [];
  const rule = (part: string, outbound: string, match: Record<string, unknown>) =>
    out.push({
      type: 'field',
      ruleTag: ruleTag(c.id, part),
      inboundTag: [c.inboundTag],
      ...match,
      outboundTag: outbound,
    });
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

type Template = Record<string, unknown> & {
  outbounds?: Record<string, unknown>[];
  routing?: Record<string, unknown> & { rules?: Record<string, unknown>[] };
};

/**
 * Шаблон Xray с каскадами входа: свои outbound-ы и правила заменяются целиком, чужое остаётся
 * на месте. Свои правила - сразу после правил api (до правил владельца: иначе его "Базовые
 * соединения" перехватят трафик каскада). Каскадов нет - своего в шаблоне не остаётся.
 */
export function mergeTemplate(
  template: Template,
  outbounds: Record<string, unknown>[],
  rules: Record<string, unknown>[],
): Template {
  const keepOut = (template.outbounds ?? []).filter((o) => !own(o.tag));
  const routing = { ...(template.routing ?? {}) };
  const keepRules = (routing.rules ?? []).filter((r) => !own(r.ruleTag));
  let at = 0;
  keepRules.forEach((r, i) => {
    if (r.outboundTag === 'api' || (Array.isArray(r.inboundTag) && r.inboundTag.includes('api')))
      at = i + 1;
  });
  const ownOut = outbounds.length ? [...SERVICE_OUTBOUNDS, ...outbounds] : [];
  return {
    ...template,
    outbounds: [...keepOut, ...ownOut],
    routing: { ...routing, rules: [...keepRules.slice(0, at), ...rules, ...keepRules.slice(at)] },
  };
}

/** Свои части шаблона (outbound-ы и правила каскадов) - для сравнения "уже стоит". */
export function ownParts(template: Template): string {
  return JSON.stringify({
    o: (template.outbounds ?? []).filter((o) => own(o.tag)),
    r: (template.routing?.rules ?? []).filter((r) => own(r.ruleTag)),
  });
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

/**
 * Кандидаты цели Reality для входа: крупные российские сайты (TLS 1.3, h2, X25519 проверяет
 * 3X-UI на самом сервере). Зарубежная цель на российском адресе выглядит странно для DPI.
 */
export const RU_REALITY_CANDIDATES = [
  'ya.ru:443',
  'www.ozon.ru:443',
  'www.wildberries.ru:443',
  'www.avito.ru:443',
  'vk.com:443',
  'dzen.ru:443',
  'rutube.ru:443',
  'www.kinopoisk.ru:443',
  'mail.ru:443',
  'www.gosuslugi.ru:443',
  'www.sberbank.ru:443',
  'www.tbank.ru:443',
];

/** Подпись inbound-а входа в 3X-UI. */
export const entryRemark = (exitName: string) => `-> ${exitName}`.slice(0, 100);
