import { join } from 'node:path';
import {
  type AgentLogPull,
  type Inventory,
  LOG_CATEGORIES,
  LOG_DAYS_MAX,
  LOG_DEFAULTS,
  LOG_MB_MAX,
  LOG_MB_MIN,
  type LogAccessState,
  type LogSettings,
  type Metrics,
  type ReachProbe,
  type ServerReach,
  actionTitle,
} from '@vps/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { actionLog, gclientBindings, gclients, servers } from '../db/schema.js';
import { onActionDone } from './action-journal.js';
import type { ConnsHub } from './conns-hub.js';
import type { RuReach } from './ru-reach.js';
import { schedule } from './schedule.js';
import { type LogLevel, ServerLog, type XrayUsers } from './server-log.js';
import { onServerRemoved } from './server-remove.js';
import { getJsonSetting, putSetting } from './settings.js';
import { PANEL_VERSION } from './version.js';

const SETTINGS_KEY = 'server_log';
const PRUNE_MS = 60 * 60_000;
/** Забор буфера агентов (системный журнал, нагрузка, назначения). */
const PULL_MS = 60_000;
/** За один забор - не больше стольких запросов по 2000 событий (после долгого перерыва). */
const PULL_PAGES = 25;

/** Настройки журнала из базы: неизвестное и выходящее за пределы - по умолчанию. */
export function loadLogSettings(db: Db): LogSettings {
  const raw = getJsonSetting<Partial<LogSettings>>(db, SETTINGS_KEY, {});
  const days = { ...LOG_DEFAULTS.days };
  for (const c of LOG_CATEGORIES) {
    const v = raw.days?.[c];
    if (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= LOG_DAYS_MAX)
      days[c] = v as number;
  }
  const mb = raw.maxMb;
  return {
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : LOG_DEFAULTS.enabled,
    days,
    maxMb:
      Number.isInteger(mb) && (mb as number) >= LOG_MB_MIN && (mb as number) <= LOG_MB_MAX
        ? (mb as number)
        : LOG_DEFAULTS.maxMb,
  };
}

export function saveLogSettings(db: Db, s: LogSettings) {
  putSetting(db, SETTINGS_KEY, JSON.stringify(s));
}

/** Итог проверки цели словами: "Адрес сервера (TCP 22): 9 из 10, 45 мс". */
function reachText(t: ServerReach['targets'][number]): { level: LogLevel; text: string } {
  const what = `${t.title} (${t.kind.toUpperCase()} ${t.port}${t.sni ? `, ${t.sni}` : ''})`;
  if (t.error) return { level: 'warn', text: `${what}: проверка не состоялась: ${t.error}` };
  const pct = t.percent ?? 0;
  const level: LogLevel = pct >= 80 ? 'info' : pct >= 50 ? 'warn' : 'error';
  return {
    level,
    text: `${what}: дошли ${t.ok} из ${t.total}${t.rtt !== undefined ? `, ${t.rtt} мс` : ''}`,
  };
}

/**
 * Журнал серверов: события реестра агентов (связь, метрики, снимки), действия, подключения,
 * проверки доступности; ежечасно - сроки хранения и предел размера. Возвращает журнал и
 * остановку.
 */
export function startServerLog(deps: {
  db: Db;
  registry: AgentRegistry;
  conns: ConnsHub;
  reach: RuReach;
  dataDir: string;
  log: { warn: (o: unknown, m?: string) => void };
}): { slog: ServerLog; stop: () => void; access: () => LogAccessState[] } {
  const { db, registry, conns, reach, log } = deps;
  const file = deps.dataDir === ':memory:' ? ':memory:' : join(deps.dataDir, 'logs.db');
  const slog = new ServerLog(file);
  slog.configure(loadLogSettings(db));
  const safe = (what: string, fn: () => void) => {
    try {
      fn();
    } catch (e) {
      log.warn({ err: (e as Error).message }, `журнал серверов: ${what}`);
    }
  };
  const refs = () =>
    slog.refs(
      db.select({ id: servers.id, name: servers.name, host: servers.host }).from(servers).all(),
    );
  safe('серверы', refs);
  slog.event({
    serverId: null,
    category: 'agent',
    level: 'info',
    type: 'panel.start',
    text: `Панель запущена (${PANEL_VERSION})`,
  });

  const since = new Map<string, number>();
  const onOnline = (id: string) =>
    safe('online', () => {
      since.set(id, Date.now());
      const conn = registry.get(id);
      const row = db
        .select({ agentVersion: servers.agentVersion })
        .from(servers)
        .where(eq(servers.id, id))
        .get();
      slog.event({
        serverId: id,
        category: 'agent',
        level: 'info',
        type: 'online',
        text: `Агент на связи${conn?.addr ? ` с ${conn.addr}` : ''}`,
        ip: conn?.addr ?? null,
        data: { agentVersion: row?.agentVersion ?? null, updating: registry.isUpdating(id) },
      });
    });
  const onOffline = (id: string, reason: string) =>
    safe('offline', () => {
      const from = since.get(id);
      since.delete(id);
      const updating = registry.isUpdating(id);
      slog.event({
        serverId: id,
        category: 'agent',
        level: updating ? 'info' : 'warn',
        type: 'offline',
        text: `Агент не на связи: ${reason || 'причина неизвестна'}${updating ? ' (обновление агента)' : ''}`,
        data: {
          reason,
          updating,
          ...(from ? { onlineSec: Math.round((Date.now() - from) / 1000) } : {}),
        },
      });
    });
  // агент с буфером присылает нагрузку по минутам сам, и за время без связи тоже
  const onMetrics = (id: string, m: Metrics) =>
    safe('нагрузка', () => {
      if (!registry.supports(id, 'events.pull')) slog.metric(id, m);
    });
  const onInventory = (id: string, inv: Inventory) => safe('снимок', () => slog.inventory(id, inv));
  registry.on('online', onOnline);
  registry.on('offline', onOffline);
  registry.on('metrics', onMetrics);
  registry.on('inventory', onInventory);

  const clientNames = (ids: string[]) =>
    new Map(
      ids.length
        ? db
            .select({ id: gclients.id, name: gclients.name })
            .from(gclients)
            .where(inArray(gclients.id, ids))
            .all()
            .map((r) => [r.id, r.name])
        : [],
    );
  conns.onView = (id, view) => safe('подключения', () => slog.conns(id, view, clientNames));

  reach.onResult = (id, out, probes) =>
    safe('доступность', () => {
      const byKey = new Map<string, ReachProbe[]>(probes.map((p) => [p.key, p.probes]));
      if (out.error && !out.targets.some((t) => t.checkedAt === out.checkedAt))
        slog.event({
          serverId: id,
          category: 'reach',
          level: 'warn',
          type: 'reach.error',
          text: `Проверка доступности не состоялась: ${out.error}`,
        });
      for (const t of out.targets) {
        // в итоге остаются и прошлые результаты целей, которые сейчас не проверялись
        if (t.checkedAt !== out.checkedAt && !t.error && !byKey.has(t.key)) continue;
        const { level, text } = reachText(t);
        slog.event({
          serverId: id,
          category: 'reach',
          level,
          type: 'reach',
          text,
          data: {
            key: t.key,
            kind: t.kind,
            port: t.port,
            sni: t.sni ?? null,
            source: t.source,
            percent: t.percent,
            ok: t.ok,
            total: t.total,
            rtt: t.rtt ?? null,
            error: t.error ?? null,
            remaining: out.remaining ?? null,
            byToken: out.byToken ?? null,
            probes: byKey.get(t.key) ?? [],
          },
        });
      }
    });

  const stopDone = onActionDone((a) =>
    safe('действие', () => {
      // журнал доступа включён или выключен - состояние в настройках сразу
      if (a.kind === 'xray:accesslog') void pull(a.serverId);
      const row = db.select().from(actionLog).where(eq(actionLog.id, a.id)).get();
      const started = row ? Date.parse(row.startedAt) : Number.NaN;
      const title = actionTitle(a.kind, row?.params);
      slog.event({
        serverId: a.serverId,
        category: 'action',
        level: a.exitCode === 0 ? 'info' : 'error',
        type: a.kind,
        text: `${title}: ${a.exitCode === 0 ? 'выполнено' : `ошибка (код ${a.exitCode})`}`,
        actionId: a.id,
        data: {
          exitCode: a.exitCode,
          initiator: row?.initiator ?? null,
          startedAt: row?.startedAt ?? null,
          ...(Number.isFinite(started)
            ? { durationSec: Math.round((Date.now() - started) / 1000) }
            : {}),
          params: row?.params ?? {},
          ...(a.exitCode !== 0 ? { output: ServerLog.tail(a.output) } : {}),
        },
      });
    }),
  );

  const stopRemoved = onServerRemoved((id) =>
    safe('удаление сервера', () => {
      slog.event({
        serverId: id,
        category: 'agent',
        level: 'info',
        type: 'server.removed',
        text: 'Сервер удалён из панели',
      });
      slog.forget(id);
    }),
  );

  // пользователи xray сервера -> клиенты панели (как в подключениях)
  const xrayUsers: XrayUsers = (serverId) =>
    new Map(
      db
        .select({ ref: gclientBindings.ref, id: gclients.id, name: gclients.name })
        .from(gclientBindings)
        .innerJoin(gclients, eq(gclients.id, gclientBindings.clientId))
        .where(and(eq(gclientBindings.serverId, serverId), eq(gclientBindings.service, 'xui')))
        .all()
        .map((r) => [r.ref, { id: r.id, name: r.name }]),
    );
  const accessOf = new Map<string, AgentLogPull['access']>();
  const pulling = new Set<string>();
  const pull = async (id: string) => {
    if (pulling.has(id) || !registry.isOnline(id) || !registry.supports(id, 'events.pull')) return;
    pulling.add(id);
    try {
      for (let i = 0; i < PULL_PAGES; i++) {
        const st = slog.pullState(id);
        const r = await registry.request<AgentLogPull>(
          id,
          'events.pull',
          { epoch: st.epoch, after: st.after, limit: 2000 },
          { timeoutMs: 30_000 },
        );
        accessOf.set(id, r.access);
        slog.ingest(id, r, xrayUsers);
        if (!r.more) break;
      }
    } catch (e) {
      if (registry.isOnline(id))
        log.warn({ serverId: id, err: (e as Error).message }, 'журнал серверов: забор у агента');
    } finally {
      pulling.delete(id);
    }
  };
  const pullAll = () => {
    for (const id of registry.onlineIds()) void pull(id);
  };
  const stopPull = schedule(pullAll, 30_000, PULL_MS);
  // после переподключения - накопленное за время без связи (через 5 с: запрос до welcome агент
  // считает нарушением)
  const onOnlinePull = (id: string) => {
    setTimeout(() => void pull(id), 5_000).unref();
  };
  registry.on('online', onOnlinePull);

  /** Серверы с 3X-UI и журнал доступа xray на них. */
  const access = (): LogAccessState[] =>
    db
      .select({ id: servers.id, name: servers.name, cache: servers.statusCache })
      .from(servers)
      .all()
      .filter((r) => r.cache?.inventory?.services.some((x) => x.kind === 'xui'))
      .map((r) => {
        const a = accessOf.get(r.id);
        return {
          serverId: r.id,
          name: r.name,
          enabled: a ? a.enabled : null,
          ...(a?.path ? { path: a.path } : {}),
          ...(a?.error ? { error: a.error } : {}),
          online: registry.isOnline(r.id),
          agent: registry.supports(r.id, 'events.pull'),
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

  const stopPrune = schedule(
    () =>
      safe('очистка', () => {
        refs();
        slog.prune();
      }),
    5 * 60_000,
    PRUNE_MS,
  );

  return {
    slog,
    access,
    stop: () => {
      stopPull();
      registry.off('online', onOnlinePull);
      stopDone();
      stopRemoved();
      stopPrune();
      registry.off('online', onOnline);
      registry.off('offline', onOffline);
      registry.off('metrics', onMetrics);
      registry.off('inventory', onInventory);
      conns.onView = null;
      reach.onResult = null;
      slog.close();
    },
  };
}
