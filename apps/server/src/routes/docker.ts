import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { DockerRef } from '../lib/validate.js';

/** Docker сервера: действия над контейнерами и их логи. */
export async function dockerRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);
  const { quickAction } = actionRunners(registry, journal);

  app.post('/api/servers/:id/docker/:cid/:action', async (req, reply) => {
    const { id, cid, action } = z
      .object({
        id: z.string(),
        cid: DockerRef,
        action: z.enum(['start', 'stop', 'restart', 'remove']),
      })
      .parse(req.params);
    await quickAction(id, `docker.${action}`, 'docker.action', { id: cid, action }, 120_000);
    return reply.send({ ok: true });
  });
  app.get('/api/servers/:id/docker/:cid/logs', async (req, reply) => {
    const { id, cid } = z.object({ id: z.string(), cid: DockerRef }).parse(req.params);
    const { tail } = z
      .object({ tail: z.coerce.number().int().min(10).max(5000).default(500) })
      .parse(req.query);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
    return registry.request(id, 'docker.logs', { id: cid, tail }, { timeoutMs: 60_000 });
  });
}
