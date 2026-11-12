import type {
  ClientConnAddr,
  ClientConnsView,
  ConnGuess,
  ConnsListSnapshot,
  ConnsView,
} from '@vps/protocol';
import { eq, inArray } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { gclients, servers } from '../db/schema.js';
import { buildConns } from './conn-detail.js';
import { schedule } from './schedule.js';

/** Снимок сервера отдаётся всем смотрящим не чаще раза в это время (вкладка опрашивает раз в 5 с). */
const VIEW_TTL_MS = 4_000;
/** Сколько помним адрес клиента для догадок на других серверах. */
export const SEEN_TTL_MS = 60 * 60_000;
/** Последний снимок другого сервера для "виден неопознанным" - не старше этого. */
const ELSEWHERE_MAX_AGE_MS = 5 * 60_000;
/** Фоновый обход серверов: журнал адресов наполняется и без открытых вкладок. */
const REFRESH_MS = 2 * 60_000;

interface Seen {
  clientId: string;
  serverId: string;
  at: number;
}

/**
 * Журнал адресов клиентов: адрес -> где и у какого клиента был опознан. Только в памяти: после
 * перезапуска панели наполняется заново фоновым обходом.
 */
export class SeenAddrs {
  private byIp = new Map<string, Map<string, Seen>>();

  constructor(private now: () => number = Date.now) {}

  add(ip: string, clientId: string, serverId: string, at: number) {
    let m = this.byIp.get(ip);
    if (!m) {
      m = new Map();
      this.byIp.set(ip, m);
    }
    const key = `${clientId}|${serverId}`;
    if ((m.get(key)?.at ?? 0) < at) m.set(key, { clientId, serverId, at });
  }

  /** Записи адреса не старше SEEN_TTL_MS, свежие первыми. */
  get(ip: string): Seen[] {
    const m = this.byIp.get(ip);
    if (!m) return [];
    const from = this.now() - SEEN_TTL_MS;
    for (const [k, s] of m) if (s.at < from) m.delete(k);
    if (m.size === 0) this.byIp.delete(ip);
    return [...m.values()].sort((a, b) => b.at - a.at);
  }

  prune() {
    for (const ip of [...this.byIp.keys()]) this.get(ip);
  }
}

type Registry = Pick<AgentRegistry, 'request' | 'latestMetrics' | 'isOnline' | 'supports'>;

/**
 * Подключения серверов: снимок conns.list с подписями панели один на всех смотрящих (вкладка,
 * страница клиента, уведомления) и журнал адресов клиентов. Неопознанный адрес, который недавно
 * был у клиента на этом или другом сервере, получает догадку: скорее всего, это устройство клиента
 * подключается к сервису без опознания (MTProxy, WDTT) или чужим ключом.
 */
export class ConnsHub {
  readonly seen: SeenAddrs;
  private views = new Map<string, { at: number; view: ConnsView }>();
  private inflight = new Map<string, Promise<ConnsView | null>>();

  constructor(
    private db: Db,
    private registry: Registry,
    private panelIps: () => Promise<string[]>,
    private now: () => number = Date.now,
  ) {
    this.seen = new SeenAddrs(now);
  }

  /** Подключения сервера не старше maxAgeMs; сервера нет - null, агент не ответил - исключение. */
  async view(serverId: string, maxAgeMs = VIEW_TTL_MS): Promise<ConnsView | null> {
    const hit = this.views.get(serverId);
    if (hit && this.now() - hit.at < maxAgeMs) return hit.view;
    const running = this.inflight.get(serverId);
    if (running) return running;
    const p = this.load(serverId).finally(() => this.inflight.delete(serverId));
    this.inflight.set(serverId, p);
    return p;
  }

  private async load(serverId: string): Promise<ConnsView | null> {
    const row = this.db.select().from(servers).where(eq(servers.id, serverId)).get();
    if (!row) return null;
    const snap = await this.registry.request<ConnsListSnapshot>(
      serverId,
      'conns.list',
      {},
      { timeoutMs: 10_000 },
    );
    const view = buildConns(this.db, serverId, snap, {
      services: row.statusCache?.inventory?.services ?? [],
      panelIps: await this.panelIps(),
      clients: this.registry.latestMetrics(serverId)?.metrics.conns?.clients ?? null,
    });
    this.remember(serverId, view, snap.at);
    this.guess(view);
    this.views.set(serverId, { at: this.now(), view });
    return view;
  }

  /** Опознанные адреса клиентов - в журнал. */
  private remember(serverId: string, view: ConnsView, at: number) {
    for (const a of view.addrs) {
      if (a.kind !== 'client') continue;
      for (const u of a.users) if (u.clientId) this.seen.add(a.ip, u.clientId, serverId, at);
    }
    for (const p of view.awg) if (p.clientId) this.seen.add(p.ip, p.clientId, serverId, at);
  }

  /** Неопознанным адресам - клиенты, у которых этот адрес был за последний час. */
  private guess(view: ConnsView) {
    const unknown = view.addrs.filter((a) => a.kind === 'unknown');
    const hits = new Map(unknown.map((a) => [a.ip, this.seen.get(a.ip)]));
    const all = [...hits.values()].flat();
    if (all.length === 0) return;
    const names = this.names(
      all.map((s) => s.clientId),
      all.map((s) => s.serverId),
    );
    for (const a of unknown) {
      const guess: ConnGuess[] = [];
      for (const s of hits.get(a.ip) ?? []) {
        const name = names.clients.get(s.clientId);
        if (!name) continue;
        guess.push({
          clientId: s.clientId,
          name,
          serverId: s.serverId,
          serverName: names.servers.get(s.serverId) ?? 'удалённый сервер',
          at: new Date(s.at).toISOString(),
        });
      }
      if (guess.length === 0) continue;
      a.guess = guess;
      a.note =
        'Не опознан напрямую, но за последний час этот адрес был у клиента панели: вероятно, его устройство подключается к сервису без опознания (MTProxy, WDTT). Один адрес бывает и у нескольких абонентов оператора';
    }
  }

  private names(clientIds: string[], serverIds: string[]) {
    const clients = new Map(
      this.db
        .select({ id: gclients.id, name: gclients.name })
        .from(gclients)
        .where(inArray(gclients.id, [...new Set(clientIds)]))
        .all()
        .map((r) => [r.id, r.name]),
    );
    const srv = new Map(
      this.db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .where(inArray(servers.id, [...new Set(serverIds)]))
        .all()
        .map((r) => [r.id, r.name]),
    );
    return { clients, servers: srv };
  }

  /** Адреса клиента на сервере: из снимка сервера, с тем же адресом на других серверах. */
  async clientConns(clientId: string, serverId: string): Promise<ClientConnsView> {
    if (!this.registry.isOnline(serverId))
      return { at: null, addrs: [], error: 'сервер не в сети' };
    if (!this.registry.supports(serverId, 'conns.list'))
      return { at: null, addrs: [], error: 'агент сервера не отдаёт подключения: обновите агента' };
    const view = await this.view(serverId);
    if (!view) return { at: null, addrs: [], error: 'сервер не найден' };

    const byIp = new Map<string, ClientConnAddr>();
    const addr = (ip: string) => {
      let a = byIp.get(ip);
      if (!a) {
        a = { ip, conns: 0, ports: [], via: [], elsewhere: [] };
        byIp.set(ip, a);
      }
      return a;
    };
    for (const a of view.addrs) {
      if (!a.users.some((u) => u.clientId === clientId)) continue;
      const x = addr(a.ip);
      x.conns = a.conns;
      x.ports = a.ports;
      x.via.push('VLESS');
    }
    for (const p of view.awg) {
      if (p.clientId !== clientId) continue;
      const x = addr(p.ip);
      x.via.push(p.device ? `AWG: ${p.device}` : 'AWG');
      if (!x.handshakeAt || x.handshakeAt < p.handshakeAt) x.handshakeAt = p.handshakeAt;
    }
    if (byIp.size === 0) return { at: view.at, addrs: [] };

    // тот же адрес на других серверах: опознан у этого клиента (журнал) или виден неопознанным
    // (последние снимки серверов)
    const others = new Map<string, Map<string, ClientConnAddr['elsewhere'][number]>>();
    const put = (ip: string, e: ClientConnAddr['elsewhere'][number]) => {
      let m = others.get(ip);
      if (!m) {
        m = new Map();
        others.set(ip, m);
      }
      if (!m.has(e.serverId)) m.set(e.serverId, e);
    };
    const now = this.now();
    for (const [id, { at, view: v }] of this.views) {
      if (id === serverId || now - at > ELSEWHERE_MAX_AGE_MS) continue;
      for (const a of v.addrs)
        if (a.kind === 'unknown' && byIp.has(a.ip))
          put(a.ip, { serverId: id, serverName: '', kind: 'unknown', conns: a.conns, at: v.at });
    }
    for (const ip of byIp.keys())
      for (const s of this.seen.get(ip))
        if (s.clientId === clientId && s.serverId !== serverId)
          put(ip, {
            serverId: s.serverId,
            serverName: '',
            kind: 'client',
            at: new Date(s.at).toISOString(),
          });
    const srvIds = [...others.values()].flatMap((m) => [...m.keys()]);
    const { servers: names } = this.names([], srvIds);
    for (const [ip, m] of others) {
      const x = byIp.get(ip);
      if (!x) continue;
      x.elsewhere = [...m.values()]
        .filter((e) => names.has(e.serverId))
        .map((e) => ({ ...e, serverName: names.get(e.serverId) ?? '' }))
        .sort((a, b) => a.serverName.localeCompare(b.serverName, 'ru'));
    }
    return {
      at: view.at,
      addrs: [...byIp.values()].sort((a, b) => b.conns - a.conns || a.ip.localeCompare(b.ip)),
    };
  }

  /** Обход серверов в сети: свежие снимки для журнала адресов. */
  async refreshAll() {
    this.seen.prune();
    const rows = this.db.select({ id: servers.id }).from(servers).all();
    for (const { id } of rows) {
      if (!this.registry.isOnline(id) || !this.registry.supports(id, 'conns.list')) {
        this.views.delete(id);
        continue;
      }
      await this.view(id).catch(() => null);
    }
  }

  start(): () => void {
    return schedule(() => void this.refreshAll().catch(() => undefined), 20_000, REFRESH_MS);
  }
}
