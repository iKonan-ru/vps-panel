import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { RuReach } from '../lib/ru-reach.js';

/** Доступность из России (lib/ru-reach.ts): итоги, проверка сейчас, токен Globalping. */
export async function reachRoutes(app: FastifyInstance, opts: { reach: RuReach }) {
  const { reach } = opts;

  app.get('/api/reach', async () => reach.all());

  app.get('/api/servers/:id/reach', async (req) => reach.get((req.params as { id: string }).id));

  app.post('/api/servers/:id/reach/check', async (req) =>
    reach.manual((req.params as { id: string }).id),
  );

  app.get('/api/reach/settings', async () => ({ tokenSet: reach.tokenSet() }));

  /** Токен Globalping: пустая строка - убрать. В браузер обратно не отдаётся. */
  app.put('/api/reach/settings', async (req) => {
    const { token } = z
      .object({
        token: z
          .string()
          .trim()
          .max(200)
          .regex(/^[A-Za-z0-9_.-]*$/),
      })
      .parse(req.body ?? {});
    reach.setToken(token);
    return { tokenSet: reach.tokenSet() };
  });
}
