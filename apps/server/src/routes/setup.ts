import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ServerSetup } from '../lib/server-setup.js';

const Id = z.object({ id: z.string() });
const RunBody = z.object({
  steps: z
    .array(
      z.object({
        id: z.string().max(40),
        enabled: z.boolean(),
        answers: z.record(z.string(), z.string().max(4000)).optional(),
      }),
    )
    .max(40),
  from: z.string().max(40).optional(),
  backupId: z.string().max(40).optional(),
});

/** Настройка сервера в один клик: план с ходом прошлого запуска, проверки, запуск. */
export async function setupRoutes(app: FastifyInstance, opts: { setup: ServerSetup }) {
  const { setup } = opts;
  app.get('/api/servers/:id/setup', async (req) => {
    const { backup } = z.object({ backup: z.string().max(40).optional() }).parse(req.query);
    return setup.plan(Id.parse(req.params).id, backup);
  });
  /** Ход последнего запуска (без плана: план считает ответы команд, это дольше). */
  app.get('/api/servers/:id/setup/progress', async (req) => ({
    progress: setup.progress(Id.parse(req.params).id),
  }));
  app.post('/api/servers/:id/setup/preflight', async (req) =>
    setup.preflight(Id.parse(req.params).id, RunBody.parse(req.body ?? {})),
  );
  app.post('/api/servers/:id/setup/run', async (req) =>
    setup.run(Id.parse(req.params).id, RunBody.parse(req.body ?? {})),
  );
}
