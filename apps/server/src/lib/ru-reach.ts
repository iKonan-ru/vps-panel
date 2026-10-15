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
 * (details.ruReach), панель забирает его итог раз в 3 минуты - каждую его проверку. Уровни как у
 * MTProxyL: от 80% - видно, от 50% - частично, ниже - не видно. Уведомление - цель не видна две
 * проверки подряд и снова видна.
 *
 * Время у всех целей общее: проверки агента - в :00 и :30, интерфейс рисует историю получасовыми
 * интервалами (SLOT_MS), поэтому графики разных целей и серверов совпадают по времени. Зонды
 * последних проверок (откуда дошли, откуда нет) - отдельно, по серверу: ru_reach_probes:<id>.
 *
 * Задержка (rtt, мс) - время установки TCP-соединения у дошедших зондов: медиана по проверке у
 * цели и в точке истории, своя у каждого зонда. Её даёт только проверка агента (новые агенты);
 * у MTProxyL в его итоге времени нет.
 */

export type ReachLevel = 'ok' | 'partial' | 'bad';

/** Зонд проверки: город, сеть и её AS, дошёл ли; ошибка - если нет; задержка - если дошёл. */
export interface ReachProbe {
  city: string;
  asn: number;
  network: string;
  ok: boolean;
  error?: string;
  rtt?: number;
}

/** Зонды проверок цели по времени проверки (последние PROBES_MS). */
export type ProbeStore = Record<string, { at: string; probes: ReachProbe[] }[]>;

export interface ReachPoint {
  at: string;
  percent: number;
  total: number;
  /** Медиана задержки проверки, мс. */
  rtt?: number;
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
  /** Медиана задержки последней проверки, мс; нет - не мерили (MTProxyL, старый агент). */
  rtt?: number | undefined;
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
    probes?: unknown;
    rtt?: number;
  }[];
  remaining: number;
}

/** Итог проверки MTProxyL в снимке агента (details.ruReach). */
interface MtReach {
  checkedAt: string;
  percent: number;
  total: number;
  ok: number;
  error?: string;
  target?: string;
  probes?: unknown;
}

const KEY = 'ru_reach';
const TOKEN_KEY = 'globalping_token';
/** Интервал проверок агента и шаг графика: проверки в :00 и :30. */
export const SLOT_MS = 30 * 60_000;
/** Раз в сколько забирать итог MTProxyL из снимка (он проверяет себя раз в 15 минут). */
const SYNC_MS = 3 * 60_000;
const PROBES = 10;
/** История: до 96 точек (MTProxyL - 4 в час) и не старше суток. */
const HISTORY = 96;
const HISTORY_MS = 24 * 3600_000;
/** Зонды хранятся за 13 часов: график показывает 12. */
const PROBES_MS = 13 * 3600_000;
/** Ручная проверка не чаще раза в 2 минуты на сервер: каждый зонд - из квоты. */
const MANUAL_COOLDOWN_MS = 2 * 60_000;
/** Протоколы 3X-UI поверх TCP, которые можно проверить. */
const TCP_NETWORKS = new Set(['tcp', 'raw', 'ws', 'grpc', 'httpupgrade', 'xhttp', 'splithttp']);
const PROTOCOLS = new Set(['vless', 'vmess', 'trojan', 'shadowsocks']);
const MAX_INBOUNDS = 6;

/** Следующая проверка по часам: ближайшие :00 или :30 не раньше чем через минуту. */
export function nextTick(now: number): number {
  return Math.floor((now + 60_000) / SLOT_MS) * SLOT_MS + SLOT_MS;
}

/** Задержка из ответа агента: число мс в разумных пределах, до 0,1; иначе нет. */
export function readRtt(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 60_000 ? Math.round(n * 10) / 10 : undefined;
}

/** Зонды из ответа агента или снимка: только известные поля, не больше 50. */
export function readProbes(raw: unknown): ReachProbe[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 50).map((p: Record<string, unknown>) => {
    const rtt = p?.ok === true ? readRtt(p?.rtt) : undefined;
    return {
      city: String(p?.city ?? '').slice(0, 60),
      asn: Number(p?.asn) || 0,
      network: String(p?.network ?? '').slice(0, 60),
      ok: p?.ok === true,
      ...(p?.ok !== true && p?.error ? { error: String(p.error).slice(0, 160) } : {}),
      ...(rtt !== undefined ? { rtt } : {}),
    };
  });
}

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
/**
 * Ошибка проверки человеческим текстом: агент отдаёт "Globalping ответил <код>: <тело JSON,
 * обрезанное>" - вместо куска JSON понятная причина и что делать.
 */
export function reachError(raw: string): string {
  const m = /^Globalping ответил (\d{3})(?::\s*([\s\S]*))?$/.exec(raw.trim());
  if (!m) return raw;
  const code = Number(m[1]);
  const detail = /"message"\s*:\s*"([^"]{1,200})"/.exec(m[2] ?? '')?.[1];
  if (code === 401 || code === 403)
    return 'Globalping не принял токен: его нужно заменить или удалить в \u00abНастройки\u00bb\u00a0\u2014 \u00abДоступность из России\u00bb';
  if (code === 429) return 'лимит проверок Globalping исчерпан, повтор при следующей проверке';
  if (code >= 500)
    return `Globalping временно недоступен (HTTP ${code}), повтор при следующей проверке`;
  return `Globalping отклонил запрос (HTTP ${code})${detail ? `: ${detail}` : ''}`;
}

export function apply(
  t: ReachTarget,
  r: { percent: number; total: number; ok: number; errors: string[]; at: string; rtt?: unknown },
): { text: string; back: boolean } | null {
  t.percent = r.percent;
  t.total = r.total;
  t.ok = r.ok;
  t.errors = r.errors;
  t.checkedAt = r.at;
  t.error = undefined;
  const rtt = readRtt(r.rtt);
  t.rtt = rtt;
  const since = Date.parse(r.at) - HISTORY_MS;
  const point: ReachPoint = { at: r.at, percent: r.percent, total: r.total };
  if (rtt !== undefined) point.rtt = rtt;
  t.history = [...t.history, point].filter((p) => Date.parse(p.at) >= since).slice(-HISTORY);
  const lv = level(r.percent);
  if (lv === 'bad') {
    t.badStreak += 1;
    if (t.badStreak >= 2 && !t.notified) {
      t.notified = true;
      return {
        back: false,
        text: `${t.title} не виден из России: дошли ${r.ok} из ${r.total}\u00a0зондов (${r.percent}%)${
          r.errors[0] ? `; ${r.errors[0]}` : ''
        }`,
      };
    }
    return null;
  }
  t.badStreak = 0;
  if (lv === 'ok' && t.notified) {
    t.notified = false;
    return {
      back: true,
      text: `${t.title} снова виден из России: ${r.ok} из ${r.total}\u00a0зондов (${r.percent}%)`,
    };
  }
  return null;
}

/** Новая цель без итогов. */
export function blank(
  key: string,
  title: string,
  kind: 'tcp' | 'tls',
  port: number,
  source: ReachTarget['source'],
  sni?: string,
): ReachTarget {
  return {
    key,
    title,
    kind,
    port,
    ...(sni ? { sni } : {}),
    percent: null,
    total: 0,
    ok: 0,
    errors: [],
    checkedAt: null,
    history: [],
    badStreak: 0,
    notified: false,
    source,
  };
}

/** Убрать цели inbound-ов 3X-UI (сервиса на сервере больше нет); true - что-то убрано. */
export function dropXui(entry: ServerReach): boolean {
  const n = entry.targets.length;
  entry.targets = entry.targets.filter((t) => !t.key.startsWith('xui:'));
  return entry.targets.length !== n;
}

/**
 * MTProxyL в запись сервера: цель из его собственной проверки в снимке, новая точка - если
 * проверка новая; нет MTProxyL - нет и цели. Возвращает уведомление и зонды новой проверки.
 */
export function mergeMt(
  entry: ServerReach,
  details: Record<string, unknown> | undefined | null,
  installed: boolean,
): {
  note?: { key: string; text: string; back: boolean };
  probes?: { at: string; probes: ReachProbe[] };
} {
  const i = entry.targets.findIndex((t) => t.key === 'mtproxyl');
  const mr = details?.ruReach as MtReach | undefined;
  if (!installed || !mr?.checkedAt) {
    if (i >= 0) entry.targets.splice(i, 1);
    return {};
  }
  const port = Number(/:(\d+)/.exec(mr.target ?? '')?.[1] ?? 443);
  let t = entry.targets[i];
  if (!t) {
    t = blank('mtproxyl', 'MTProxyL', 'tls', port, 'mtproxyl');
    entry.targets.push(t);
  }
  t.port = port;
  if (mr.error) {
    t.error = `проверка MTProxyL: ${mr.error}`;
    return {};
  }
  t.error = undefined;
  if (mr.checkedAt === t.checkedAt) return {};
  const msg = apply(t, {
    percent: Math.round(mr.percent * 10) / 10,
    total: mr.total,
    ok: mr.ok,
    errors: [],
    at: mr.checkedAt,
  });
  return {
    ...(msg ? { note: { key: t.key, ...msg } } : {}),
    probes: { at: mr.checkedAt, probes: readProbes(mr.probes) },
  };
}

export class RuReach {
  private running = new Map<string, Promise<ServerReach>>();
  private manualAt = new Map<string, number>();

  constructor(
    private db: Db,
    private box: SecretBox,
    private registry: AgentRegistry,
    private log: { warn: (o: unknown, m?: string) => void },
    private notify: (
      serverId: string,
      note: { key: string; text: string; back: boolean },
    ) => Promise<void>,
  ) {}

  /**
   * Проверки агентов - по часам в :00 и :30 (графики всех целей совпадают по времени); через
   * 3 минуты после запуска - только серверы, у которых проверка пропущена (панель была выключена
   * или обновлялась); итог MTProxyL - раз в 3 минуты.
   */
  start() {
    let tick: NodeJS.Timeout | undefined;
    const arm = () => {
      const now = Date.now();
      tick = setTimeout(() => {
        void this.checkAll();
        arm();
      }, nextTick(now) - now).unref();
    };
    arm();
    const first = setTimeout(() => void this.checkAll(SLOT_MS - 5 * 60_000), 3 * 60_000).unref();
    const stopSync = schedule(() => void this.syncAll(), 60_000, SYNC_MS);
    return () => {
      if (tick) clearTimeout(tick);
      clearTimeout(first);
      stopSync();
    };
  }

  private load(): Store {
    const store = getJsonSetting<Store>(this.db, KEY, {});
    // сохранённые до человеческих текстов ошибки - тоже человеческим текстом
    for (const r of Object.values(store)) {
      if (r.error) r.error = reachError(r.error);
      for (const t of r.targets) if (t.error) t.error = reachError(t.error);
    }
    return store;
  }

  private save(store: Store) {
    putSetting(this.db, KEY, JSON.stringify(store));
  }

  /** Зонды проверок цели за последние 13 часов (для окна подробностей). */
  probes(serverId: string, key: string): { at: string; probes: ReachProbe[] }[] {
    return getJsonSetting<ProbeStore>(this.db, `ru_reach_probes:${serverId}`, {})[key] ?? [];
  }

  /** Новые зонды в хранилище сервера; цели не из keep и старше 13 часов уходят. */
  private addProbes(
    serverId: string,
    items: { key: string; at: string; probes: ReachProbe[] }[],
    keep: Set<string>,
  ) {
    const name = `ru_reach_probes:${serverId}`;
    const cur = getJsonSetting<ProbeStore>(this.db, name, {});
    const since = Date.now() - PROBES_MS;
    const out: ProbeStore = {};
    for (const k of keep) {
      const list = (cur[k] ?? []).filter((p) => Date.parse(p.at) >= since);
      if (list.length) out[k] = list;
    }
    for (const it of items) {
      if (!keep.has(it.key) || !it.probes.length) continue;
      const list = out[it.key] ?? [];
      list.push({ at: it.at, probes: it.probes });
      out[it.key] = list;
    }
    putSetting(this.db, name, JSON.stringify(out));
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

  /** Проверка серверов на связи; staleMs - только тех, чей итог старше (пропущенные). */
  private async checkAll(staleMs?: number) {
    const rows = await this.db.select({ id: servers.id }).from(servers);
    const store = staleMs ? this.load() : {};
    const fresh = (id: string) => {
      const at = store[id]?.checkedAt;
      return (
        staleMs !== undefined &&
        at !== null &&
        at !== undefined &&
        Date.now() - Date.parse(at) < staleMs
      );
    };
    await Promise.all(
      rows
        .filter((r) => this.registry.isOnline(r.id) && !fresh(r.id))
        .map((r) =>
          this.check(r.id).catch((e: Error) =>
            this.log.warn({ serverId: r.id, err: e.message }, 'ru-reach'),
          ),
        ),
    );
  }

  /** Итоги MTProxyL из снимков: каждая его проверка - точка в истории, без запросов к агенту. */
  private async syncAll() {
    try {
      const rows = await this.db
        .select({ id: servers.id, statusCache: servers.statusCache })
        .from(servers);
      const store = this.load();
      const notes: { serverId: string; note: { key: string; text: string; back: boolean } }[] = [];
      let changed = false;
      for (const row of rows) {
        const inv = (row.statusCache as StatusCache | null)?.inventory;
        if (!inv) continue;
        const mt = inv.services.find((s) => s.kind === 'mtproxyl');
        const entry = store[row.id] ?? { checkedAt: null, targets: [] };
        // 3X-UI сняли (удаление, переустановка ОС): его inbound-ы не ждут проверки агента в :00/:30
        if (!inv.services.some((s) => s.kind === 'xui') && dropXui(entry)) {
          store[row.id] = entry;
          changed = true;
        }
        const had = entry.targets.some((t) => t.key === 'mtproxyl');
        if (!mt && !had) continue;
        const before = JSON.stringify(entry.targets.find((t) => t.key === 'mtproxyl') ?? null);
        const r = mergeMt(entry, mt?.details, Boolean(mt));
        if (JSON.stringify(entry.targets.find((t) => t.key === 'mtproxyl') ?? null) === before)
          continue;
        store[row.id] = entry;
        changed = true;
        if (r.note) notes.push({ serverId: row.id, note: r.note });
        if (r.probes)
          this.addProbes(
            row.id,
            [{ key: 'mtproxyl', ...r.probes }],
            new Set(entry.targets.map((t) => t.key)),
          );
      }
      if (changed) this.save(store);
      for (const n of notes) await this.notify(n.serverId, n.note).catch(() => undefined);
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'ru-reach mtproxyl');
    }
  }

  /** Inbound удалили из панели: его цель уходит сразу, не дожидаясь проверки в :00/:30. */
  dropInbound(serverId: string, inboundId: number) {
    const store = this.load();
    const entry = store[serverId];
    if (!entry) return;
    const n = entry.targets.length;
    entry.targets = entry.targets.filter((t) => t.key !== `xui:${inboundId}`);
    if (entry.targets.length !== n) this.save(store);
  }

  /** Проверка кнопкой: не чаще раза в 2 минуты на сервер. */
  async manual(serverId: string): Promise<ServerReach> {
    const last = this.manualAt.get(serverId) ?? 0;
    const wait = MANUAL_COOLDOWN_MS - (Date.now() - last);
    if (wait > 0)
      throw Object.assign(
        new Error(
          `следующая проверка\u00a0\u2014 через ${Math.ceil(wait / 1000)}\u00a0с: зонды расходуют квоту Globalping`,
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
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
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
      const t = blank(key, title, kind, port, source, sni);
      if (!o) return t;
      return {
        ...t,
        percent: o.percent,
        total: o.total,
        ok: o.ok,
        errors: o.errors,
        ...(o.error ? { error: o.error } : {}),
        checkedAt: o.checkedAt,
        ...(o.rtt !== undefined ? { rtt: o.rtt } : {}),
        history: o.history,
        badStreak: o.badStreak,
        notified: o.notified,
      };
    };
    const probes: { key: string; at: string; probes: ReachProbe[] }[] = [];
    const messages: { key: string; text: string; back: boolean }[] = [];
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
        out.error = `inbound 3X-UI: ${(e as Error).message}`;
      }
    }
    const targets = agentTargets.map((t) => make(t.key, t.title, t.kind, t.port, 'agent', t.sni));
    if (!this.registry.isOnline(serverId)) {
      out.error = 'сервер не в сети';
    } else if (!this.registry.supports(serverId, 'reach.check')) {
      out.error = 'агент устарел: для проверки адреса и inbound нужно обновить агент';
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
            t.error = reachError(res.error);
            continue;
          }
          const msg = apply(t, { ...res, at: now });
          if (msg) messages.push({ key: t.key, ...msg });
          probes.push({ key: t.key, at: now, probes: readProbes(res.probes) });
        }
      } catch (e) {
        out.error = reachError((e as Error).message);
      }
    }
    out.targets.push(...targets);

    // MTProxyL: итог его собственной проверки из снимка - поверх свежей записи (его забирает и
    // syncAll, пока шла проверка агента)
    const store = this.load();
    const freshMt = store[serverId]?.targets.find((t) => t.key === 'mtproxyl');
    if (freshMt) out.targets.push(freshMt);
    const mt = inv?.services.find((s) => s.kind === 'mtproxyl');
    const m = mergeMt(out, mt?.details, Boolean(mt));
    if (m.note) messages.push(m.note);
    if (m.probes) probes.push({ key: 'mtproxyl', ...m.probes });

    store[serverId] = out;
    this.save(store);
    this.addProbes(serverId, probes, new Set(out.targets.map((t) => t.key)));
    for (const m of messages) await this.notify(serverId, m).catch(() => undefined);
    return out;
  }
}
