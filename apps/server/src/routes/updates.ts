import type { FastifyInstance } from 'fastify';
import { type AgentRegistry, requireOnline } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { actionJournal } from '../lib/action-journal.js';
import type { ServiceUpdates } from '../lib/service-updates.js';
import type { UiHub } from '../lib/ui-hub.js';

/** Обновления 3X-UI, Xray и MTProxyL: блок "Обслуживание", версии во вкладке MTProxyL. */
export async function updateRoutes(
  app: FastifyInstance,
  opts: { db: Db; hub: UiHub; registry: AgentRegistry; updates: ServiceUpdates },
) {
  const { registry, updates } = opts;
  const journal = actionJournal(opts.db, opts.hub, registry);

  app.get('/api/updates', async () => updates.listAll());

  app.get('/api/servers/:id/updates', async (req) =>
    updates.list((req.params as { id: string }).id),
  );

  /** Проверить сервер сейчас: кнопка во вкладке и после обновления сервиса. */
  app.post('/api/servers/:id/updates/check', async (req) => {
    const { id } = req.params as { id: string };
    requireOnline(registry, id);
    return updates.recheck(id);
  });

  app.get('/api/servers/:id/mtproxyl/versions', async (req) =>
    updates.versions((req.params as { id: string }).id),
  );
  app.get('/api/servers/:id/xui/versions', async (req) =>
    updates.versions((req.params as { id: string }).id, ['xui', 'xray']),
  );

  /** Обновить Xray внутри 3X-UI до версии из последней проверки: действие с выводом. */
  app.post('/api/servers/:id/xray/update', async (req) => {
    const { id } = req.params as { id: string };
    requireOnline(registry, id);
    return {
      actionId: journal.background(id, 'xui:xray', {}, (action) => updates.installXray(id, action)),
    };
  });
}
