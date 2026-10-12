import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { FirefoxSigner } from '../lib/firefox.js';

/** Расширение Firefox: ключ API addons.mozilla.org и подпись (Настройки). */
export async function firefoxRoutes(app: FastifyInstance, opts: { firefox: FirefoxSigner }) {
  const { firefox } = opts;

  app.get('/api/settings/firefox', async () => firefox.view());

  app.put('/api/settings/firefox', async (req) => {
    const body = z
      .object({
        issuer: z.string().trim().min(1).max(200),
        secret: z.string().trim().min(1).max(200),
      })
      .parse(req.body ?? {});
    firefox.setKey(body);
    // новая версия подписывается в фоне: окно не ждёт Mozilla (минуты)
    void firefox.ensure();
    return firefox.view();
  });

  app.delete('/api/settings/firefox', async () => {
    firefox.setKey(null);
    return firefox.view();
  });

  /** Подписать сейчас (в фоне; ход - в view().busy, ошибка - view().error). */
  app.post('/api/settings/firefox/sign', async (_req, reply) => {
    const v = firefox.view();
    if (!v.keySet) return reply.code(400).send({ error: 'не задан ключ API addons.mozilla.org' });
    if (!v.busy) void firefox.sign().catch(() => undefined);
    return { ...firefox.view(), busy: true };
  });
}
