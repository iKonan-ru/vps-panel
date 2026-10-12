import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../agents/registry.js';
import type { ServiceUpdates } from '../lib/service-updates.js';

/** Обновления 3X-UI и MTProxyL: блок "Обслуживание", версии во вкладке MTProxyL. */
export async function updateRoutes(
  app: FastifyInstance,
  opts: { registry: AgentRegistry; updates: ServiceUpdates },
) {
  const { registry, updates } = opts;

  app.get('/api/updates', async () => updates.listAll());

  app.get('/api/servers/:id/updates', async (req) =>
    updates.list((req.params as { id: string }).id),
  );

  /** Проверить сервер сейчас: кнопка во вкладке и после обновления сервиса. */
  app.post('/api/servers/:id/updates/check', async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    return updates.recheck(id);
  });

  app.get('/api/servers/:id/mtproxyl/versions', async (req) =>
    updates.versions((req.params as { id: string }).id),
  );
}
