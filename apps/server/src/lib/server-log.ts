import { statSync } from 'node:fs';
import {
  type AgentLogPull,
  type ConnsView,
  type Inventory,
  LOG_CATEGORIES,
  LOG_DEFAULTS,
  type LogCategory,
  type LogFilter,
  type LogSettings,
  type LogStats,
  type Metrics,
} from '@vps/protocol';
import Database from 'better-sqlite3';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Адрес не виден дольше этого - его сеанс закончился, следующее появление - новый сеанс. */
export const SESSION_GAP_MS = 6 * MIN;
/** Снимок подключений сервера пишется не чаще (вкладка "Подключения" опрашивает раз в 5 с). */
const CONNS_EVERY_MS = MIN;
/** Нагрузка - строка в минуту; старше недели сворачивается в строку в час. */
const METRIC_STEP_MS = MIN;
const METRIC_ROLLUP_AFTER_MS = 7 * DAY;
/** Время загрузки сервера сдвинулось больше чем на это - была перезагрузка. */
const BOOT_DRIFT_MS = 3 * MIN;
/** Записи об операциях с журналом (выгрузка, удаление) хранятся год. */
const OPS_DAYS = 365;
/** Хвост вывода неудачного действия в событии. */
const OUTPUT_TAIL = 4_000;

export type LogLevel = 'info' | 'warn' | 'error';

/** Раздел события: разделы журнала, кроме таблиц сеансов и нагрузки, и операции с журналом. */
export type EventCategory = Exclude<LogCategory, 'conn' | 'metric' | 'dest'> | 'logs';

/** Пользователь xray (email) -> клиент панели на этом сервере. */
export type XrayUsers = (serverId: string) => Map<string, { id: string; name: string }>;

export interface LogEvent {
  serverId: string | null;
  category: EventCategory;
  level: LogLevel;
  /** Вид события латиницей: online, offline, reach, action, service.added... */
  type: string;
  /** Что произошло, для человека. */
  text: string;
  clientId?: string | null;
  clientName?: string | null;
  ip?: string | null;
  actionId?: string | null;
  data?: unknown;
  at?: number;
}

/** Строка выгрузки: событие, сеанс подключения или нагрузка - в общем виде. */
export interface LogRow {
  type: 'event' | 'conn' | 'metric' | 'dest';
  at: string;
  until?: string;
  serverId: string | null;
  server: string;
  category: string;
  level: string;
  event: string;
  clientId: string | null;
  client: string | null;
  ip: string | null;
  actionId: string | null;
  text: string;
  data: unknown;
}

const SCHEMA = `
create table if not exists event (
  id integer primary key, at integer not null, server_id text, category text not null,
  level text not null, type text not null, text text not null, client_id text, client_name text,
  ip text, action_id text, data text
);
create index if not exists event_server on event(server_id, at);
create index if not exists event_cat on event(category, at);
create index if not exists event_ip on event(ip, at) where ip is not null;
create index if not exists event_client on event(client_id, at) where client_id is not null;
create table if not exists conn (
  id integer primary key, server_id text not null, ip text not null, kind text not null,
  via text not null, name text, client_id text, client_name text, first_at integer not null,
  last_at integer not null, samples integer not null, max_conns integer not null, data text
);
create index if not exists conn_server on conn(server_id, last_at);
create index if not exists conn_ip on conn(ip, last_at);
create index if not exists conn_client on conn(client_id, last_at) where client_id is not null;
create index if not exists conn_last on conn(last_at);
create table if not exists metric (
  server_id text not null, at integer not null, span integer not null, cpu real,
  mem_used integer, mem_total integer, disk_used real, disk_total real, rx real, tx real,
  load1 real, uptime integer, clients integer, tcp integer, ips integer, awg integer,
  primary key (server_id, at, span)
) without rowid;
create index if not exists metric_at on metric(at);
create table if not exists dest (
  server_id text not null, hour integer not null, email text not null, client_id text,
  client_name text, host text not null, port integer not null, net text not null,
  outbound text not null, n integer not null,
  primary key (server_id, hour, email, host, port, net, outbound)
) without rowid;
create index if not exists dest_hour on dest(hour);
create index if not exists dest_client on dest(client_id, hour) where client_id is not null;
create index if not exists dest_host on dest(host, hour);
create table if not exists kv (key text primary key, value text not null);
create table if not exists server_ref (id text primary key, name text not null, host text not null);
`;

/** Строка сводки назначений агента. */
interface DestIn {
  email: string;
  host: string;
  port: number;
  net: string;
  out: string;
  n: number;
}

interface ConnData {
  ports: { port: number; label: string; conns: number }[];
  guess?: string[];
  device?: string;
  rx0?: number;
  tx0?: number;
  rx?: number;
  tx?: number;
}

interface ConnSample {
  key: string;
  ip: string;
  kind: string;
  via: string;
  name: string | null;
  clientId: string | null;
  conns: number;
  data: ConnData;
}

/** Что сравнивается между снимками агента. */
interface InvDigest {
  services: Record<string, string>;
  containers: Record<string, string>;
  listeners: string[];
  bans: Record<string, string[]>;
  ssh: { port: number; password: boolean; root: string; fail2ban: boolean };
  agent: string;
  kernel: string;
  os: string;
  unchecked: string[];
}

function digest(inv: Inventory): InvDigest {
  return {
    services: Object.fromEntries(
      inv.services.map((s) => [`${s.kind}|${s.title}`, s.version ?? '']),
    ),
    containers: Object.fromEntries(inv.containers.map((c) => [c.name, c.state])),
    listeners: [
      ...new Set(inv.firewall.listeners.map((l) => `${l.proto}/${l.port} ${l.process}`)),
    ].sort(),
    bans: Object.fromEntries(inv.audit.jails.map((j) => [j.name, [...j.bannedIps].sort()])),
    ssh: {
      port: inv.audit.sshPort,
      password: inv.audit.sshPasswordAuth,
      root: inv.audit.sshPermitRootLogin,
      fail2ban: inv.audit.fail2banRunning,
    },
    agent: inv.host.agentVersion,
    kernel: inv.host.kernel,
    os: inv.host.os,
    unchecked: inv.unchecked,
  };
}

/** События по разнице двух снимков агента. */
export function inventoryEvents(serverId: string, a: InvDigest, b: InvDigest): LogEvent[] {
  const out: LogEvent[] = [];
  const ev = (level: LogLevel, type: string, text: string, extra: Partial<LogEvent> = {}) =>
    out.push({ serverId, category: 'server', level, type, text, ...extra });
  const title = (key: string) => key.split('|')[1] ?? key;
  const kind = (key: string) => key.split('|')[0] ?? '';
  for (const [k, v] of Object.entries(b.services)) {
    const old = a.services[k];
    if (old === undefined)
      ev('info', 'service.added', `Сервис ${title(k)} появился${v ? ` (${v})` : ''}`);
    else if (old !== v)
      ev('info', 'service.version', `Сервис ${title(k)}: версия ${old || '?'} -> ${v || '?'}`);
  }
  for (const k of Object.keys(a.services))
    if (!(k in b.services) && !b.unchecked.includes(kind(k)))
      ev('warn', 'service.removed', `Сервис ${title(k)} пропал из снимка`);
  for (const [name, st] of Object.entries(b.containers)) {
    const old = a.containers[name];
    if (old === undefined) ev('info', 'container.added', `Контейнер ${name}: ${st}`);
    else if (old !== st)
      ev(
        st === 'running' ? 'info' : 'warn',
        'container.state',
        `Контейнер ${name}: ${old} -> ${st}`,
        {
          data: { from: old, to: st },
        },
      );
  }
  if (!b.unchecked.includes('docker'))
    for (const name of Object.keys(a.containers))
      if (!(name in b.containers)) ev('info', 'container.removed', `Контейнер ${name} удалён`);
  const was = new Set(a.listeners);
  const now = new Set(b.listeners);
  for (const l of b.listeners) if (!was.has(l)) ev('info', 'port.opened', `Порт открыт: ${l}`);
  for (const l of a.listeners) if (!now.has(l)) ev('info', 'port.closed', `Порт закрыт: ${l}`);
  for (const [jail, ips] of Object.entries(b.bans)) {
    const old = new Set(a.bans[jail] ?? []);
    for (const ip of ips)
      if (!old.has(ip))
        ev('warn', 'fail2ban.ban', `fail2ban (${jail}): бан ${ip}`, { ip, data: { jail } });
  }
  for (const [jail, ips] of Object.entries(a.bans)) {
    const cur = new Set(b.bans[jail] ?? []);
    for (const ip of ips)
      if (!cur.has(ip))
        ev('info', 'fail2ban.unban', `fail2ban (${jail}): снят бан ${ip}`, { ip, data: { jail } });
  }
  if (JSON.stringify(a.ssh) !== JSON.stringify(b.ssh))
    ev('warn', 'ssh', 'Изменились настройки SSH или fail2ban', {
      data: { from: a.ssh, to: b.ssh },
    });
  if (a.agent !== b.agent) ev('info', 'agent.version', `Агент: ${a.agent} -> ${b.agent}`);
  if (a.kernel !== b.kernel || a.os !== b.os)
    ev('info', 'os', `Система: ${a.os} ${a.kernel} -> ${b.os} ${b.kernel}`);
  return out;
}

/** Подключения снимка - выборки сеансов: адрес и пользователь (или пир AWG). */
export function connSamples(view: ConnsView): ConnSample[] {
  const out: ConnSample[] = [];
  for (const a of view.addrs) {
    const ports = a.ports.map((p) => ({ port: p.port, label: p.label, conns: p.conns }));
    const guess = a.guess?.map((g) => g.name);
    const users = a.users.length ? a.users : [null];
    for (const u of users)
      out.push({
        key: `tcp|${a.ip}|${u?.name ?? ''}`,
        ip: a.ip,
        kind: a.kind,
        via: 'tcp',
        name: u?.name ?? a.name,
        clientId: u?.kind === 'client' ? (u.clientId ?? null) : (a.clientId ?? null),
        conns: a.conns,
        data: { ports, ...(guess?.length ? { guess } : {}) },
      });
  }
  for (const p of view.awg)
    out.push({
      key: `awg|${p.ip}|${p.name}`,
      ip: p.ip,
      kind: p.kind,
      via: 'awg',
      name: p.name,
      clientId: p.clientId ?? null,
      conns: 0,
      data: { ports: [], ...(p.device ? { device: p.device } : {}), rx: p.rx, tx: p.tx },
    });
  return out;
}

function mergePorts(a: ConnData['ports'], b: ConnData['ports']): ConnData['ports'] {
  const m = new Map(a.map((p) => [p.port, { ...p }]));
  for (const p of b) {
    const x = m.get(p.port);
    if (!x) m.set(p.port, { ...p });
    else x.conns = Math.max(x.conns, p.conns);
  }
  return [...m.values()].sort((x, y) => x.port - y.port);
}

const iso = (ms: number) => new Date(ms).toISOString();
const parse = (s: string | null): unknown => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** Где-условие и параметры фильтра для таблицы. */
function where(
  f: LogFilter,
  cols: { at: string; until?: string; server: string; client?: string; ip?: string },
): { sql: string; args: unknown[] } {
  const parts: string[] = [];
  const args: unknown[] = [];
  if (f.servers?.length) {
    parts.push(`${cols.server} in (${f.servers.map(() => '?').join(',')})`);
    args.push(...f.servers);
  }
  if (f.from) {
    parts.push(`${cols.until ?? cols.at} >= ?`);
    args.push(Date.parse(f.from));
  }
  if (f.to) {
    parts.push(`${cols.at} < ?`);
    args.push(Date.parse(f.to));
  }
  if (f.clientId && cols.client) {
    parts.push(`${cols.client} = ?`);
    args.push(f.clientId);
  }
  if (f.ip && cols.ip) {
    parts.push(`${cols.ip} = ?`);
    args.push(f.ip);
  }
  return { sql: parts.length ? `where ${parts.join(' and ')}` : '', args };
}

/** Какие таблицы и разделы событий касаются фильтра. */
function scope(f: LogFilter) {
  const cats = f.categories?.length ? f.categories : [...LOG_CATEGORIES];
  const events: string[] = cats.filter((c) => c !== 'conn' && c !== 'metric' && c !== 'dest');
  // операции с журналом - вместе с полным набором разделов
  if (!f.categories?.length) events.push('logs');
  return {
    events,
    conn: cats.includes('conn'),
    // у нагрузки нет клиента и адреса: фильтр по ним её не касается
    metric: cats.includes('metric') && !f.clientId && !f.ip,
    // адрес в фильтре - назначение с этим адресом
    dest: cats.includes('dest'),
  };
}

/**
 * Журнал серверов в своей базе (logs.db рядом с panel.db, не входит в резервную копию панели):
 * события по разделам, сеансы подключений адресов, нагрузка по минутам. Сроки хранения и
 * предел размера - из настроек; выключенный журнал ничего не пишет.
 */
export class ServerLog {
  readonly sqlite: Database.Database;
  private cfg: LogSettings = LOG_DEFAULTS;
  /** Открытые сеансы подключений: сервер|ключ -> строка и когда адрес видели. */
  private open = new Map<string, { id: number; lastAt: number; data: ConnData }>();
  private connsAt = new Map<string, number>();
  private metricAt = new Map<string, number>();

  constructor(
    readonly file: string,
    private now: () => number = Date.now,
  ) {
    this.sqlite = new Database(file);
    // свободные страницы после удаления возвращаются файлу (pragma incremental_vacuum);
    // действует только на новой базе, до первой таблицы
    this.sqlite.pragma('auto_vacuum = incremental');
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.exec(SCHEMA);
    this.loadOpen();
  }

  close() {
    this.sqlite.close();
  }

  get settings(): LogSettings {
    return this.cfg;
  }

  configure(s: LogSettings) {
    this.cfg = s;
  }

  private loadOpen() {
    this.open.clear();
    const rows = this.sqlite
      .prepare('select id, server_id, ip, via, name, last_at, data from conn where last_at >= ?')
      .all(this.now() - SESSION_GAP_MS) as {
      id: number;
      server_id: string;
      ip: string;
      via: string;
      name: string | null;
      last_at: number;
      data: string | null;
    }[];
    for (const r of rows)
      this.open.set(`${r.server_id}|${r.via}|${r.ip}|${r.name ?? ''}`, {
        id: r.id,
        lastAt: r.last_at,
        data: (parse(r.data) as ConnData | null) ?? { ports: [] },
      });
  }

  event(e: LogEvent) {
    if (!this.cfg.enabled) return;
    this.write(e);
  }

  private write(e: LogEvent) {
    this.sqlite
      .prepare(
        `insert into event (at, server_id, category, level, type, text, client_id, client_name,
          ip, action_id, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.at ?? this.now(),
        e.serverId,
        e.category,
        e.level,
        e.type,
        e.text,
        e.clientId ?? null,
        e.clientName ?? null,
        e.ip ?? null,
        e.actionId ?? null,
        e.data === undefined ? null : JSON.stringify(e.data),
      );
  }

  /** Снимок подключений сервера: продлить сеансы видимых адресов или открыть новые. */
  conns(serverId: string, view: ConnsView, clientNames: (ids: string[]) => Map<string, string>) {
    if (!this.cfg.enabled) return;
    const now = this.now();
    if (now - (this.connsAt.get(serverId) ?? 0) < CONNS_EVERY_MS) return;
    this.connsAt.set(serverId, now);
    const samples = connSamples(view);
    const names = clientNames([
      ...new Set(samples.map((s) => s.clientId).filter((x): x is string => Boolean(x))),
    ]);
    const insert = this.sqlite.prepare(
      `insert into conn (server_id, ip, kind, via, name, client_id, client_name, first_at,
        last_at, samples, max_conns, data) values (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const update = this.sqlite.prepare(
      `update conn set last_at = ?, samples = samples + 1, max_conns = max(max_conns, ?),
        kind = ?, client_id = coalesce(?, client_id), client_name = coalesce(?, client_name),
        data = ? where id = ?`,
    );
    this.sqlite.transaction(() => {
      for (const s of samples) {
        const key = `${serverId}|${s.via}|${s.ip}|${s.name ?? ''}`;
        const cur = this.open.get(key);
        const clientName = s.clientId ? (names.get(s.clientId) ?? null) : null;
        if (cur && now - cur.lastAt <= SESSION_GAP_MS) {
          const data: ConnData = {
            ...cur.data,
            ...s.data,
            ports: mergePorts(cur.data.ports, s.data.ports),
            ...(cur.data.rx0 !== undefined ? { rx0: cur.data.rx0, tx0: cur.data.tx0 } : {}),
          };
          update.run(now, s.conns, s.kind, s.clientId, clientName, JSON.stringify(data), cur.id);
          this.open.set(key, { id: cur.id, lastAt: now, data });
        } else {
          const data: ConnData = {
            ...s.data,
            ...(s.data.rx !== undefined ? { rx0: s.data.rx, tx0: s.data.tx } : {}),
          };
          const r = insert.run(
            serverId,
            s.ip,
            s.kind,
            s.via,
            s.name,
            s.clientId,
            clientName,
            now,
            now,
            s.conns,
            JSON.stringify(data),
          );
          this.open.set(key, { id: Number(r.lastInsertRowid), lastAt: now, data });
        }
      }
    })();
    for (const [k, v] of this.open) if (now - v.lastAt > SESSION_GAP_MS) this.open.delete(k);
  }

  /**
   * Метрики агента: строка в минуту; сдвиг времени загрузки - событие о перезагрузке. at -
   * время замера из буфера агента: без проверки частоты и без события о перезагрузке (о ней
   * агент сообщает по системному журналу).
   */
  metric(serverId: string, m: Metrics, at?: number) {
    if (!this.cfg.enabled) return;
    const now = at ?? this.now();
    if (at === undefined) {
      if (now - (this.metricAt.get(serverId) ?? 0) < METRIC_STEP_MS) return;
      this.metricAt.set(serverId, now);
    }
    this.sqlite
      .prepare(
        `insert or replace into metric (server_id, at, span, cpu, mem_used, mem_total, disk_used,
          disk_total, rx, tx, load1, uptime, clients, tcp, ips, awg)
          values (?, ?, 60, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        serverId,
        Math.floor(now / METRIC_STEP_MS) * METRIC_STEP_MS,
        m.cpuPercent,
        m.memUsedMb,
        m.memTotalMb,
        m.diskUsedGb,
        m.diskTotalGb,
        m.netRxBps,
        m.netTxBps,
        m.load1,
        m.uptimeSec,
        m.conns?.clients ?? null,
        m.conns?.tcp ?? null,
        m.conns?.ips ?? null,
        m.conns?.awg ?? null,
      );
    if (at !== undefined) return;
    const bootAt = now - m.uptimeSec * 1000;
    const key = `boot:${serverId}`;
    const prev = Number(this.kv(key) ?? Number.NaN);
    if (Number.isFinite(prev) && Math.abs(bootAt - prev) <= BOOT_DRIFT_MS) return;
    this.setKv(key, String(bootAt));
    if (Number.isFinite(prev) && bootAt > prev)
      this.write({
        serverId,
        category: 'server',
        level: 'warn',
        type: 'reboot',
        text: `Сервер перезагружен около ${iso(bootAt).slice(0, 16).replace('T', ' ')} UTC`,
        at: bootAt,
        data: { bootAt: iso(bootAt), uptimeSec: m.uptimeSec },
      });
  }

  /** С какого события забирать буфер агента: эпоха буфера и последнее сохранённое. */
  pullState(serverId: string): { epoch: string; after: number } {
    const v = parse(this.kv(`pull:${serverId}`) ?? null) as {
      epoch?: string;
      after?: number;
    } | null;
    return { epoch: v?.epoch ?? '', after: v?.after ?? 0 };
  }

  /**
   * Забранное у агента: нагрузка, системный журнал, назначения. Сохраняется вместе с отметкой
   * забранного (одной транзакцией): следующий забор подтверждает их агенту. Выключенный
   * журнал отметку двигает, но не пишет - буфер агента не копится зря.
   */
  ingest(serverId: string, pull: AgentLogPull, users: XrayUsers): number {
    const last = pull.events.at(-1)?.seq;
    const prev = this.pullState(serverId);
    let after = 0;
    this.sqlite.transaction(() => {
      if (this.cfg.enabled) {
        let resolve: ReturnType<XrayUsers> | null = null;
        const up = this.sqlite.prepare(
          `insert into dest (server_id, hour, email, client_id, client_name, host, port, net,
            outbound, n) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            on conflict (server_id, hour, email, host, port, net, outbound)
            do update set n = n + excluded.n, client_id = coalesce(excluded.client_id, client_id),
              client_name = coalesce(excluded.client_name, client_name)`,
        );
        if (pull.dropped > 0)
          this.write({
            serverId,
            category: 'agent',
            level: 'warn',
            type: 'agent.dropped',
            text: `Агент потерял ${pull.dropped} записей журнала: буфер переполнился, пока панель их не забирала`,
            data: { dropped: pull.dropped },
          });
        for (const e of pull.events) {
          const at = Date.parse(e.at);
          if (!Number.isFinite(at)) continue;
          if (e.kind === 'metric') {
            this.metric(serverId, e.data as Metrics, at);
            continue;
          }
          if (e.kind === 'dest') {
            const d = e.data as { hour?: string; rows?: DestIn[] } | undefined;
            const hour = Date.parse(d?.hour ?? '');
            if (!Number.isFinite(hour) || !Array.isArray(d?.rows)) continue;
            resolve ??= users(serverId);
            for (const r of d.rows) {
              const c = resolve.get(r.email);
              up.run(
                serverId,
                hour,
                r.email,
                c?.id ?? null,
                c?.name ?? null,
                r.host,
                r.port,
                r.net,
                r.out,
                r.n,
              );
            }
            continue;
          }
          this.write({
            serverId,
            category: 'server',
            level: e.level === 'error' || e.level === 'warn' ? e.level : 'info',
            type: e.kind,
            text: e.text ?? e.kind,
            ip: e.ip ?? null,
            data: e.data,
            at,
          });
        }
      }
      after = last ?? (prev.epoch === pull.epoch ? prev.after : 0);
      this.setKv(`pull:${serverId}`, JSON.stringify({ epoch: pull.epoch, after }));
    })();
    return after;
  }

  /** Снимок агента: изменения относительно прошлого снимка - событиями. */
  inventory(serverId: string, inv: Inventory) {
    if (!this.cfg.enabled) return;
    const key = `inv:${serverId}`;
    const next = digest(inv);
    const raw = JSON.stringify(next);
    const old = this.kv(key);
    if (old === raw) return;
    this.setKv(key, raw);
    if (!old) return;
    const prev = parse(old) as InvDigest;
    const events = inventoryEvents(serverId, prev, next);
    this.sqlite.transaction(() => {
      for (const e of events) this.write(e);
    })();
  }

  /** Сервер удалён из панели: его снимки для сравнения больше не нужны, записи остаются. */
  forget(serverId: string) {
    this.sqlite
      .prepare('delete from kv where key in (?, ?)')
      .run(`inv:${serverId}`, `boot:${serverId}`);
    this.connsAt.delete(serverId);
    this.metricAt.delete(serverId);
  }

  /** Имена и адреса серверов для выгрузки; удалённые из панели остаются с последним именем. */
  refs(list: { id: string; name: string; host: string }[]) {
    const up = this.sqlite.prepare(
      `insert into server_ref (id, name, host) values (?, ?, ?)
        on conflict(id) do update set name = excluded.name, host = excluded.host`,
    );
    this.sqlite.transaction(() => {
      for (const s of list) up.run(s.id, s.name, s.host);
    })();
  }

  private kv(key: string): string | undefined {
    return (
      this.sqlite.prepare('select value from kv where key = ?').get(key) as
        | { value: string }
        | undefined
    )?.value;
  }

  private setKv(key: string, value: string) {
    this.sqlite
      .prepare(
        'insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value',
      )
      .run(key, value);
  }

  /** Сроки хранения, свёртка нагрузки по часам, предел размера. */
  prune() {
    const now = this.now();
    const cut = (days: number) => now - days * DAY;
    const d = this.cfg.days;
    this.sqlite.transaction(() => {
      for (const c of ['agent', 'reach', 'action', 'server'] as const)
        this.sqlite.prepare('delete from event where category = ? and at < ?').run(c, cut(d[c]));
      this.sqlite
        .prepare("delete from event where category = 'logs' and at < ?")
        .run(cut(OPS_DAYS));
      this.sqlite.prepare('delete from conn where last_at < ?').run(cut(d.conn));
      this.sqlite.prepare('delete from metric where at < ?').run(cut(d.metric));
      this.sqlite.prepare('delete from dest where hour < ?').run(cut(d.dest));
      this.rollup(now - METRIC_ROLLUP_AFTER_MS);
    })();
    this.sqlite.pragma('incremental_vacuum');
    const max = this.cfg.maxMb * 1024 * 1024;
    for (let i = 0; i < 50 && this.dbBytes() > max; i++) {
      this.trimOldest(0.05);
      this.sqlite.pragma('incremental_vacuum');
    }
    this.loadOpen();
  }

  /** Минутная нагрузка старше границы - средним (максимумом для пиков) за час. */
  private rollup(before: number) {
    const hour = `(at / ${HOUR}) * ${HOUR}`;
    this.sqlite
      .prepare(
        `insert or replace into metric (server_id, at, span, cpu, mem_used, mem_total, disk_used,
          disk_total, rx, tx, load1, uptime, clients, tcp, ips, awg)
          select server_id, ${hour}, 3600, avg(cpu), cast(avg(mem_used) as integer), max(mem_total),
            max(disk_used), max(disk_total), avg(rx), avg(tx), avg(load1), max(uptime),
            max(clients), max(tcp), max(ips), max(awg)
          from metric where span = 60 and at < ? group by server_id, ${hour}`,
      )
      .run(Math.floor(before / HOUR) * HOUR);
    this.sqlite
      .prepare('delete from metric where span = 60 and at < ?')
      .run(Math.floor(before / HOUR) * HOUR);
  }

  /** Удалить долю самых старых записей каждой таблицы. */
  private trimOldest(share: number) {
    for (const [table, order] of [
      ['event', 'id'],
      ['conn', 'last_at'],
    ] as const) {
      const n = (this.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
      const k = Math.max(1, Math.ceil(n * share));
      if (n)
        this.sqlite
          .prepare(
            `delete from ${table} where rowid in (select rowid from ${table} order by ${order} limit ?)`,
          )
          .run(k);
    }
    // таблицы без rowid - по времени: всё до границы доли самых старых
    for (const [table, col] of [
      ['metric', 'at'],
      ['dest', 'hour'],
    ] as const) {
      const n = (this.sqlite.prepare(`select count(*) n from ${table}`).get() as { n: number }).n;
      if (!n) continue;
      const at = this.sqlite
        .prepare(`select ${col} at from ${table} order by ${col} limit 1 offset ?`)
        .get(Math.max(0, Math.ceil(n * share) - 1)) as { at: number } | undefined;
      if (at) this.sqlite.prepare(`delete from ${table} where ${col} <= ?`).run(at.at);
    }
  }

  /** Занятые страницы базы (без свободных) - то, что ограничивает предел размера. */
  private dbBytes(): number {
    const pages = this.sqlite.pragma('page_count', { simple: true }) as number;
    const free = this.sqlite.pragma('freelist_count', { simple: true }) as number;
    const size = this.sqlite.pragma('page_size', { simple: true }) as number;
    return (pages - free) * size;
  }

  /** Размер файлов базы на диске. */
  fileBytes(): number {
    let n = 0;
    for (const f of [this.file, `${this.file}-wal`])
      try {
        n += statSync(f).size;
      } catch {}
    return n;
  }

  stats(): LogStats {
    const categories = Object.fromEntries(
      LOG_CATEGORIES.map((c) => [c, { rows: 0, oldest: null as string | null }]),
    ) as LogStats['categories'];
    const ev = this.sqlite
      .prepare('select category c, count(*) n, min(at) at from event group by category')
      .all() as { c: string; n: number; at: number }[];
    for (const r of ev)
      if (r.c in categories) categories[r.c as LogCategory] = { rows: r.n, oldest: iso(r.at) };
    const conn = this.sqlite.prepare('select count(*) n, min(first_at) at from conn').get() as {
      n: number;
      at: number | null;
    };
    categories.conn = { rows: conn.n, oldest: conn.at === null ? null : iso(conn.at) };
    const met = this.sqlite.prepare('select count(*) n, min(at) at from metric').get() as {
      n: number;
      at: number | null;
    };
    categories.metric = { rows: met.n, oldest: met.at === null ? null : iso(met.at) };
    const dst = this.sqlite.prepare('select count(*) n, min(hour) at from dest').get() as {
      n: number;
      at: number | null;
    };
    categories.dest = { rows: dst.n, oldest: dst.at === null ? null : iso(dst.at) };
    const servers = this.sqlite
      .prepare(
        `select s.id, coalesce(r.name, s.id) name, sum(s.n) n from (
          select server_id id, count(*) n from event where server_id is not null group by server_id
          union all select server_id, count(*) from conn group by server_id
          union all select server_id, count(*) from metric group by server_id
          union all select server_id, count(*) from dest group by server_id
        ) s left join server_ref r on r.id = s.id group by s.id order by n desc`,
      )
      .all() as { id: string; name: string; n: number }[];
    return {
      bytes: this.fileBytes(),
      categories,
      servers: servers.map((s) => ({ id: s.id, name: s.name, rows: s.n })),
    };
  }

  /** Удалить записи по фильтру; возвращает число удалённых. */
  delete(f: LogFilter): number {
    const sc = scope(f);
    let n = 0;
    this.sqlite.transaction(() => {
      if (sc.events.length) {
        const w = where(f, { at: 'at', server: 'server_id', client: 'client_id', ip: 'ip' });
        const cat = `category in (${sc.events.map(() => '?').join(',')})`;
        n += this.sqlite
          .prepare(`delete from event ${w.sql ? `${w.sql} and ${cat}` : `where ${cat}`}`)
          .run(...w.args, ...sc.events).changes;
      }
      if (sc.conn) {
        const w = where(f, {
          at: 'first_at',
          until: 'last_at',
          server: 'server_id',
          client: 'client_id',
          ip: 'ip',
        });
        n += this.sqlite.prepare(`delete from conn ${w.sql}`).run(...w.args).changes;
      }
      if (sc.metric) {
        const w = where(f, { at: 'at', server: 'server_id' });
        n += this.sqlite.prepare(`delete from metric ${w.sql}`).run(...w.args).changes;
      }
      if (sc.dest) {
        const w = where(f, { at: 'hour', server: 'server_id', client: 'client_id', ip: 'host' });
        n += this.sqlite.prepare(`delete from dest ${w.sql}`).run(...w.args).changes;
      }
    })();
    this.sqlite.pragma('incremental_vacuum');
    this.loadOpen();
    return n;
  }

  /**
   * Записи по фильтру: события, потом сеансы, потом нагрузка, каждые по времени. Читает своим
   * соединением только для чтения: запись в журнал во время долгой выгрузки не ждёт и не мешает.
   */
  *rows(f: LogFilter): Generator<LogRow> {
    const ro = new Database(this.file, { readonly: true });
    try {
      const names = new Map(
        (ro.prepare('select id, name from server_ref').all() as { id: string; name: string }[]).map(
          (r) => [r.id, r.name],
        ),
      );
      const server = (id: string | null) => (id ? (names.get(id) ?? id) : '');
      const sc = scope(f);
      if (sc.events.length) {
        const w = where(f, { at: 'at', server: 'server_id', client: 'client_id', ip: 'ip' });
        const cat = `category in (${sc.events.map(() => '?').join(',')})`;
        const it = ro
          .prepare(
            `select * from event ${w.sql ? `${w.sql} and ${cat}` : `where ${cat}`} order by at, id`,
          )
          .iterate(...w.args, ...sc.events) as IterableIterator<{
          at: number;
          server_id: string | null;
          category: string;
          level: string;
          type: string;
          text: string;
          client_id: string | null;
          client_name: string | null;
          ip: string | null;
          action_id: string | null;
          data: string | null;
        }>;
        for (const r of it)
          yield {
            type: 'event',
            at: iso(r.at),
            serverId: r.server_id,
            server: server(r.server_id),
            category: r.category,
            level: r.level,
            event: r.type,
            clientId: r.client_id,
            client: r.client_name,
            ip: r.ip,
            actionId: r.action_id,
            text: r.text,
            data: parse(r.data),
          };
      }
      if (sc.conn) {
        const w = where(f, {
          at: 'first_at',
          until: 'last_at',
          server: 'server_id',
          client: 'client_id',
          ip: 'ip',
        });
        const it = ro
          .prepare(`select * from conn ${w.sql} order by first_at, id`)
          .iterate(...w.args) as IterableIterator<{
          server_id: string;
          ip: string;
          kind: string;
          via: string;
          name: string | null;
          client_id: string | null;
          client_name: string | null;
          first_at: number;
          last_at: number;
          samples: number;
          max_conns: number;
          data: string | null;
        }>;
        for (const r of it) {
          const data = (parse(r.data) as ConnData | null) ?? { ports: [] };
          const who =
            r.client_name ??
            r.name ??
            (data.guess?.length ? `возможно ${data.guess.join(', ')}` : 'не опознан');
          yield {
            type: 'conn',
            at: iso(r.first_at),
            until: iso(r.last_at),
            serverId: r.server_id,
            server: server(r.server_id),
            category: 'conn',
            level: 'info',
            event: r.via,
            clientId: r.client_id,
            client: r.client_name,
            ip: r.ip,
            actionId: null,
            text: `${r.ip} (${r.kind}, ${who}): ${r.via === 'awg' ? 'AWG' : data.ports.map((p) => p.label || p.port).join(', ') || 'TCP'}`,
            data: {
              kind: r.kind,
              name: r.name,
              samples: r.samples,
              maxConns: r.max_conns,
              ...data,
            },
          };
        }
      }
      if (sc.metric) {
        const w = where(f, { at: 'at', server: 'server_id' });
        const it = ro
          .prepare(`select * from metric ${w.sql} order by at, server_id`)
          .iterate(...w.args) as IterableIterator<Record<string, number | string | null>>;
        for (const r of it) {
          const { server_id, at, span, ...rest } = r;
          yield {
            type: 'metric',
            at: iso(Number(at)),
            serverId: String(server_id),
            server: server(String(server_id)),
            category: 'metric',
            level: 'info',
            event: span === 3600 ? 'hour' : 'minute',
            clientId: null,
            client: null,
            ip: null,
            actionId: null,
            text: '',
            data: rest,
          };
        }
      }
      if (sc.dest) {
        const w = where(f, { at: 'hour', server: 'server_id', client: 'client_id', ip: 'host' });
        const it = ro
          .prepare(`select * from dest ${w.sql} order by hour, server_id, email, n desc`)
          .iterate(...w.args) as IterableIterator<{
          server_id: string;
          hour: number;
          email: string;
          client_id: string | null;
          client_name: string | null;
          host: string;
          port: number;
          net: string;
          outbound: string;
          n: number;
        }>;
        for (const r of it)
          yield {
            type: 'dest',
            at: iso(r.hour),
            serverId: r.server_id,
            server: server(r.server_id),
            category: 'dest',
            level: 'info',
            event: r.outbound,
            clientId: r.client_id,
            client: r.client_name,
            ip: null,
            actionId: null,
            text: `${r.client_name ?? r.email} -> ${r.host}${r.port ? `:${r.port}` : ''} (${r.net}, ${r.outbound}): ${r.n}`,
            data: {
              email: r.email,
              host: r.host,
              port: r.port,
              net: r.net,
              outbound: r.outbound,
              n: r.n,
            },
          };
      }
    } finally {
      ro.close();
    }
  }

  /** Хвост вывода для события о неудачном действии. */
  static tail(output: string): string {
    return output.length > OUTPUT_TAIL ? `...${output.slice(-OUTPUT_TAIL)}` : output;
  }
}

const CSV_COLS: (keyof LogRow)[] = [
  'type',
  'at',
  'until',
  'server',
  'category',
  'level',
  'event',
  'client',
  'ip',
  'text',
  'data',
  'serverId',
  'clientId',
  'actionId',
];

const csvCell = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return /[",\n\r;]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
};

/** Строки выгрузки текстом: JSON по строке или CSV с заголовком. */
export function* formatRows(rows: Iterable<LogRow>, format: 'jsonl' | 'csv'): Generator<string> {
  if (format === 'csv') {
    // метка порядка байтов: Excel открывает UTF-8 без неё кракозябрами
    yield `${String.fromCharCode(0xfeff)}${CSV_COLS.join(',')}\n`;
    for (const r of rows) yield `${CSV_COLS.map((c) => csvCell(r[c])).join(',')}\n`;
    return;
  }
  for (const r of rows) yield `${JSON.stringify(r)}\n`;
}
