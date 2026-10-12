import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import { getJsonSetting, getSetting, putSetting } from './settings.js';
import { parseJson, unwrap, xuiApi } from './xui-api.js';
import { savedXuiToken } from './xui-token.js';

/**
 * Доступность из России. Цели сервера: адрес (TCP до SSH) и inbound-ы 3X-UI (TLS с их SNI или
 * TCP до порта) - их проверяет агент сервера измерениями Globalping со своего адреса
 * (reach.check, раз в 30 минут); MTProxyL проверяет себя сам, его итог агент кладёт в снимок
 * (details.ruReach). Уровни как у MTProxyL: от 80% - видно, от 50% - частично, ниже - не видно.
 * Уведомление - цель не видна две проверки подряд и снова видна.
 */

export type ReachLevel = 'ok' | 'partial' | 'bad';

export interface ReachPoint {
  at: string;
  percent: number;
  total: number;
}

export interface ReachTarget {
  key: string;
  title: string;
  kind: 'tcp' | 'tls';
  port: number;
  sni?: string;
  /** null - ещё нет итога. */
  percent: number | null;
  total: number;
  ok: number;
  errors: string[];
  /** Проверка не состоялась (квота Globalping, агент устарел, сеть). */
  error?: string | undefined;
  checkedAt: string | null;
  history: ReachPoint[];
  /** Проверок подряд "не видно" и было ли уведомление о нём. */
  badStreak: number;
  notified: boolean;
  /** Кто проверяет: агент панели или сам MTProxyL. */
  source: 'agent' | 'mtproxyl';
}

export interface ServerReach {
  checkedAt: string | null;
  error?: string;
  /** Остаток квоты Globalping с адреса сервера после проверки. */
  remaining?: number;
  targets: ReachTarget[];
}

type Store = Record<string, ServerReach>;

interface AgentTarget {
  key: string;
  kind: 'tcp' | 'tls';
  host: string;
  port: number;
  sni?: string;
}
interface AgentReply {
  results: {
    key: string;
    total: number;
    ok: number;
    percent: number;
    errors: string[];
    error?: string;
  }[];
  remaining: number;
}

const KEY = 'ru_reach';
const TOKEN_KEY = 'globalping_token';
const EVERY_MS = 30 * 60_000;
const PROBES = 10;
const HISTORY = 48;
/** Ручная проверка не чаще раза в 2 минуты на сервер: каждый зонд - из квоты. */
const MANUAL_COOLDOWN_MS = 2 * 60_000;
/** Протоколы 3X-UI поверх TCP, которые можно проверить. */
const TCP_NETWORKS = new Set(['tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp', 'splithttp']);
const PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);
const MAX_INBOUNDS = 6;

export function level(percent: number | null): ReachLevel | null {
  if (percent === null) return null;
  return percent >= 80 ? 'ok' : percent >= 50 ? 'partial' : 'bad';
}

/** Цели inbound-ов 3X-UI: свои, включённые, поверх TCP; с TLS или Reality - с их SNI. */
export function inboundTargets(
  list: Record<string, unknown>[],
  host: string,
): (AgentTarget & { title: string })[] {
  const out: (AgentTarget & { title: string })[] = [];
  for (const i of list) {
    if (!i.enable || Number(i.nodeId ?? i.node_id ?? 0)) continue;
    if (!PROTOCOLS.has(String(i.protocol))) continue;
    const ss = parseJson(i.streamSettings);
    if (!TCP_NETWORKS.has(String(ss.network ?? 'tcp'))) continue;
    const port = Number(i.port);
    if (!port) continue;
    const name = String(i.remark || `#${i.id}`);
    const base = { key: `xui:${i.id}`, host, port, title: `3X-UI ${name}` };
    if (ss.security === 'reality') {
      const sni = String(
        (parseJson(ss.realitySettings).serverNames as string[] | undefined)?.[0] ?? '',
      );
      out.push({ ...base, kind: 'tls', ...(sni ? { sni } : {}) });
    } else if (ss.security === 'tls') {
      const sni = String(parseJson(ss.tlsSettings).serverName ?? '');
      out.push({ ...base, kind: 'tls', ...(sni ? { sni } : {}) });
    } else out.push({ ...base, kind: 'tcp' });
    if (out.length >= MAX_INBOUNDS) break;
  }
  return out;
}

/**
 * Итог проверки цели в её запись: процент, история, счётчик "не видно" подряд. Возвращает текст
 * уведомления, если пора (не видна вторую проверку подряд или снова видна после уведомления).
 */
export function apply(
  t: ReachTarget,
  r: { percent: number; total: number; ok: number; errors: string[]; at: string },
): string | null {
  t.percent = r.percent;
  t.total = r.total;
  t.ok = r.ok;
  t.errors = r.errors;
  t.checkedAt = r.at;
  t.error = undefined;
  t.history = [...t.history, { at: r.at, percent: r.percent, total: r.total }].slice(-HISTORY);
  const lv = level(r.percent);
  if (lv === 'bad') {
    t.badStreak += 1;
    if (t.badStreak >= 2 && !t.notified) {
      t.notified = true;
      return `${t.title} не виден из России: дошли ${r.ok} из ${r.total} зондов (${r.percent}%).${
        r.errors[0] ? ` ${r.errors[0]}` : ''
      }`;
    }
    return null;
  }
  t.badStreak = 0;
  if (lv === 'ok' && t.notified) {
    t.notified = false;
    return `${t.title} снова виден из России: ${r.ok} из ${r.total} зондов (${r.percent}%).`;
  }
  return null;
}

export class RuReach {
  private running = new Map<string, Promise<ServerReach>>();
  private manualAt = new Map<string, number>();

  constructor(
    private db: Db,
    private box: SecretBox,
    private registry: AgentRegistry,
    private log: { warn: (o: unknown, m?: string) => void },
    private notify: (serverId: string, text: string) => Promise<void>,
  ) {}

  start() {
    return schedule(() => void this.checkAll(), 3 * 60_000, EVERY_MS);
  }

  private load(): Store {
    return getJsonSetting<Store>(this.db, KEY, {});
  }

  private save(store: Store) {
    putSetting(this.db, KEY, JSON.stringify(store));
  }

  /** Токен Globalping (необязательно): с ним квота 500 зондов в час вместо 250. */
  tokenSet(): boolean {
    return Boolean(getSetting(this.db, TOKEN_KEY));
  }

  setToken(token: string) {
    putSetting(this.db, TOKEN_KEY, token ? this.box.seal(token) : '');
  }

  private token(): string {
    const v = getSetting(this.db, TOKEN_KEY);
    return v ? this.box.open(v) : '';
  }

  /** Итоги по всем серверам (или одному). */
  all(): Store {
    return this.load();
  }

  get(serverId: string): ServerReach | null {
    return this.load()[serverId] ?? null;
  }

  private async checkAll() {
    const rows = await this.db.select({ id: servers.id }).from(servers);
    await Promise.all(
      rows
        .filter((r) => this.registry.isOnline(r.id))
        .map((r) =>
          this.check(r.id).catch((e: Error) =>
            this.log.warn({ serverId: r.id, err: e.message }, 'ru-reach'),
          ),
        ),
    );
  }

  /** Проверка кнопкой: не чаще раза в 2 минуты на сервер. */
  async manual(serverId: string): Promise<ServerReach> {
    const last = this.manualAt.get(serverId) ?? 0;
    const wait = MANUAL_COOLDOWN_MS - (Date.now() - last);
    if (wait > 0)
      throw Object.assign(
        new Error(
          `проверка была только что: каждый зонд - из квоты Globalping, повтори через ${Math.ceil(wait / 1000)} с`,
        ),
        { statusCode: 429 },
      );
    this.manualAt.set(serverId, Date.now());
    return this.check(serverId);
  }

  /** Одна проверка сервера за раз: вторая ждёт итога первой. */
  check(serverId: string): Promise<ServerReach> {
    let p = this.running.get(serverId);
    if (!p) {
      p = this.run(serverId).finally(() => this.running.delete(serverId));
      this.running.set(serverId, p);
    }
    return p;
  }

  private async run(serverId: string): Promise<ServerReach> {
    const row = (await this.db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0];
    if (!row) throw Object.assign(new Error('Сервер не найден'), { statusCode: 404 });
    const inv = (row.statusCache as StatusCache | null)?.inventory;
    const now = new Date().toISOString();
    const prev = this.load()[serverId];
    const old = new Map((prev?.targets ?? []).map((t) => [t.key, t]));
    const make = (
      key: string,
      title: string,
      kind: 'tcp' | 'tls',
      port: number,
      source: ReachTarget['source'],
      sni?: string,
    ): ReachTarget => {
      const o = old.get(key);
      return {
        key,
        title,
        kind,
        port,
        ...(sni ? { sni } : {}),
        percent: o?.percent ?? null,
        total: o?.total ?? 0,
        ok: o?.ok ?? 0,
        errors: o?.errors ?? [],
        ...(o?.error ? { error: o.error } : {}),
        checkedAt: o?.checkedAt ?? null,
        history: o?.history ?? [],
        badStreak: o?.badStreak ?? 0,
        notified: o?.notified ?? false,
        source,
      };
    };
    const messages: string[] = [];
    const out: ServerReach = { checkedAt: now, targets: [] };

    // свои проверки агента: адрес и inbound-ы
    const agentTargets: (AgentTarget & { title: string })[] = [
      { key: 'ip', title: 'Адрес сервера', kind: 'tcp', host: row.host, port: row.sshPort },
    ];
    const xuiToken = inv?.services.some((s) => s.kind === 'xui')
      ? savedXuiToken(this.db, this.box, serverId)
      : '';
    if (xuiToken && this.registry.isOnline(serverId)) {
      try {
        const api = xuiApi(this.registry, serverId, xuiToken);
        const list =
          (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<
            string,
            unknown
          >[]) ?? [];
        agentTargets.push(...inboundTargets(list, row.host));
      } catch (e) {
        out.error = `inbound-ы 3X-UI: ${(e as Error).message}`;
      }
    }
    const targets = agentTargets.map((t) => make(t.key, t.title, t.kind, t.port, 'agent', t.sni));
    if (!this.registry.isOnline(serverId)) {
      out.error = 'агент не на связи';
    } else if (!this.registry.supports(serverId, 'reach.check')) {
      out.error = 'агент устарел: обнови агента, чтобы проверять адрес и inbound-ы';
    } else {
      try {
        const token = this.token();
        const r = (await this.registry.request(
          serverId,
          'reach.check',
          {
            ...(token ? { token } : {}),
            probes: PROBES,
            targets: agentTargets.map(({ title: _, ...t }) => t),
          },
          { timeoutMs: 120_000 },
        )) as AgentReply;
        if (r.remaining >= 0) out.remaining = r.remaining;
        for (const res of r.results) {
          const t = targets.find((x) => x.key === res.key);
          if (!t) continue;
          if (res.error) {
            t.error = res.error;
            continue;
          }
          const msg = apply(t, { ...res, at: now });
          if (msg) messages.push(msg);
        }
      } catch (e) {
        out.error = (e as Error).message;
      }
    }
    out.targets.push(...targets);

    // MTProxyL: итог его собственной проверки из снимка
    const mt = inv?.services.find((s) => s.kind === 'mtproxyl');
    const mr = mt?.details?.ruReach as
      | {
          checkedAt: string;
          percent: number;
          total: number;
          ok: number;
          error?: string;
          target?: string;
        }
      | undefined;
    if (mt && mr) {
      const port = Number(/:(\d+)/.exec(mr.target ?? '')?.[1] ?? 443);
      const t = make('mtproxyl', 'MTProxyL', 'tls', port, 'mtproxyl');
      if (mr.error) t.error = `проверка MTProxyL: ${mr.error}`;
      else if (mr.checkedAt !== t.checkedAt) {
        const msg = apply(t, {
          percent: Math.round(mr.percent * 10) / 10,
          total: mr.total,
          ok: mr.ok,
          errors: [],
          at: mr.checkedAt,
        });
        if (msg) messages.push(msg);
      }
      out.targets.push(t);
    }

    const store = this.load();
    store[serverId] = out;
    this.save(store);
    for (const m of messages) await this.notify(serverId, m).catch(() => undefined);
    return out;
  }
}
