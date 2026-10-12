import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { PanelUpdates } from '../lib/panel-updates.js';

/** Версия панели: новые релизы, обновление по кнопке, канал и автообновление (Настройки). */
export async function panelUpdateRoutes(app: FastifyInstance, opts: { updates: PanelUpdates }) {
  const { updates } = opts;

  app.get('/api/panel/update', async () => updates.view());

  /** Проверить сейчас (не чаще раза в минуту: лимит GitHub - 60 запросов в час). */
  let lastCheck = 0;
  app.post('/api/panel/update/check', async () => {
    if (Date.now() - lastCheck > 60_000) {
      lastCheck = Date.now();
      await updates.refresh();
    }
    return updates.view();
  });

  app.post('/api/panel/update', async (req, reply) => {
    const { version } = z.object({ version: z.string().max(40) }).parse(req.body ?? {});
    try {
      await updates.request(version);
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
    return updates.view();
  });

  app.put('/api/panel/update/settings', async (req) => {
    const body = z
      .object({
        channel: z.enum(['stable', 'beta']).optional(),
        autoUpdate: z.boolean().optional(),
        autoHour: z.number().int().min(0).max(23).optional(),
        agentsAuto: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    updates.saveSettings(body);
    return updates.view();
  });
}
