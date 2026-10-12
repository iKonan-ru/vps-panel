import type { StdMatrix } from '@vps/protocol';
import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../agents/registry.js';
import { type StatusCache, patchStatusCache, toSummary } from '../agents/state.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { panelHostOptIn } from '../lib/gclients.js';
import { panelAddresses } from '../lib/panel-host.js';
import type { ServiceUpdates } from '../lib/service-updates.js';
import { type AwgInstanceBrief, STANDARD, standardCells } from '../lib/standard.js';

/**
 * Матрица "серверы x сервисы" по эталону (lib/standard.ts). Сервер панели не входит.
 * Версии AWG - живым опросом агентов (параллельно), у серверов не в сети - из прошлого опроса.
 */
export async function standardRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; env: Env; updates: ServiceUpdates },
) {
  const { db, registry, env, updates } = opts;

  app.get('/api/standard', async (): Promise<StdMatrix> => {
    const rows = await db.select().from(servers).orderBy(servers.name);
    const ips = await panelAddresses(env.PANEL_PUBLIC_URL);
    const allUpdates = await updates.listAll();
    const out = await Promise.all(
      rows.map(async (row) => {
        const s = toSummary(row, registry, null, ips);
        // сервер панели - в эталоне, только если на нём заводятся глобальные клиенты
        if (s.panelHost && !panelHostOptIn(db)) return null;
        const cache = (row.statusCache ?? {}) as StatusCache;
        let awg: AwgInstanceBrief[] | null = cache.awgInstances ?? null;
        if (!s.services.some((x) => x.kind === 'amnezia')) awg = [];
        else if (s.status === 'online') {
          try {
            const st = (await registry.request(
              row.id,
              'awg.status',
              {},
              { timeoutMs: 30_000 },
            )) as {
              instances?: { container: string; version?: string; state?: string }[];
            };
            awg = (st.instances ?? []).map((i) => ({
              container: i.container,
              version: i.version ?? '',
              state: i.state ?? '',
            }));
            await patchStatusCache(db, row.id, { awgInstances: awg });
          } catch {
            // агент не ответил - остаётся прошлый опрос
          }
        }
        return {
          serverId: row.id,
          name: row.name,
          status: s.status,
          cells: standardCells({ services: s.services, awg, updates: allUpdates[row.id] ?? [] }),
        };
      }),
    );
    return { standard: STANDARD, rows: out.filter((r) => r !== null) };
  });
}
