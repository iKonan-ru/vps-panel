import type { Inventory, Metrics, ServerSummary } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { isPanelHost } from '../lib/panel-host.js';
import type { AgentRegistry } from './registry.js';

/** Что лежит в server.status_cache: последние метрики и inventory. */
export interface StatusCache {
  metrics?: Metrics;
  metricsAt?: string;
  inventory?: Inventory;
  /** Подсети экземпляров AWG (Address) по последнему опросу: выбор подсети для новых. */
  awgSubnets?: string[];
  /** Экземпляры AWG и их версии по последнему опросу (awg.status): матрица сервисов. */
  awgInstances?: { container: string; version: string; state: string }[];
}

/**
 * Дописать поля в снимок состояния сервера; seen - заодно отметка "был на связи". Чтение и
 * запись синхронные, без await между ними: метрики и inventory одного сервера, пришедшие
 * одновременно, не затрут друг друга.
 */
export function patchStatusCache(
  db: Db,
  serverId: string,
  patch: Partial<StatusCache>,
  seen = false,
) {
  const cur = (db
    .select({ cache: servers.statusCache })
    .from(servers)
    .where(eq(servers.id, serverId))
    .get()?.cache ?? {}) as StatusCache;
  db.update(servers)
    .set({
      statusCache: { ...cur, ...patch },
      ...(seen ? { lastSeenAt: new Date().toISOString() } : {}),
    })
    .where(eq(servers.id, serverId))
    .run();
}

/** Подписывает реестр на события и складывает снимки в базу. */
/** Как часто метрики сервера пишутся в базу. */
const METRICS_WRITE_MS = 30_000;

export function bindStateToDb(
  registry: AgentRegistry,
  db: Db,
  log: { info: (o: object, m: string) => void },
) {
  const touch = (serverId: string, patch: Partial<StatusCache>) =>
    patchStatusCache(db, serverId, patch, true);
  registry.on('heartbeat', (id) => {
    void db.update(servers).set({ lastSeenAt: new Date().toISOString() }).where(eq(servers.id, id));
  });
  // метрики приходят раз в 2 с, пока открыта вкладка панели: свежие - в памяти реестра
  // (latestMetrics), в базу - не чаще раза в 30 с (для показа после перезапуска панели)
  const written = new Map<string, number>();
  registry.on('metrics', (id, metrics) => {
    const now = Date.now();
    if (now - (written.get(id) ?? 0) < METRICS_WRITE_MS) return;
    written.set(id, now);
    touch(id, { metrics, metricsAt: new Date(now).toISOString() });
  });
  registry.on('inventory', (id, inventory) => {
    log.info({ serverId: id, services: inventory.services.length }, 'inventory');
    touch(id, { inventory });
  });
  registry.on('online', (id) => log.info({ serverId: id }, 'agent online'));
  registry.on('offline', (id) => log.info({ serverId: id }, 'agent offline'));
}

type ServerRow = typeof servers.$inferSelect;

/** Собирает ServerSummary для интерфейса из строки базы и состояния реестра. */
export function toSummary(
  row: ServerRow,
  registry: AgentRegistry,
  latestAgent: string | null = null,
  /** Адреса домена панели: сервер с таким адресом - сервер панели. */
  panelIps: string[] = [],
): ServerSummary {
  const cache = (row.statusCache ?? {}) as StatusCache;
  const online = registry.isOnline(row.id);
  const inv = cache.inventory;
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    sshPort: row.sshPort,
    tags: row.tags,
    status: online ? 'online' : row.agentTokenHash ? 'offline' : 'no-agent',
    lastSeenAt: row.lastSeenAt,
    agentVersion: row.agentVersion,
    agentUpdating: registry.isUpdating(row.id),
    agentUpdateAvailable: Boolean(
      latestAgent && row.agentVersion && row.agentVersion !== latestAgent,
    ),
    hosting: {
      provider: row.provider,
      providerServerName: row.providerServerName,
      providerUrl: row.providerUrl,
      country: row.country,
      price: row.price,
      currency: row.currency,
      billingMonths: row.billingMonths,
      nextPaymentAt: row.nextPaymentAt,
      notes: row.notes,
    },
    metrics: registry.latestMetrics(row.id)?.metrics ?? cache.metrics ?? null,
    services: inv?.services ?? [],
    audit: inv?.audit ?? null,
    firewall: inv
      ? { ufwActive: inv.firewall.ufwActive, dockerFiltered: inv.firewall.dockerFiltered }
      : null,
    dockerVersion: inv?.host.dockerVersion ?? null,
    panelHost: isPanelHost(row.host, inv, panelIps),
    // заполняет маршрут серверов (lib/panel-proxy.ts, links)
    panelLinks: {},
  };
}
