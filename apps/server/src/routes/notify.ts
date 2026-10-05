import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Telegram } from '../lib/telegram.js';

/** Настройки Telegram-уведомлений и тестовое сообщение. Токен наружу не отдаём целиком. */
export async function notifyRoutes(app: FastifyInstance, opts: { telegram: Telegram }) {
  const { telegram } = opts;

  app.get('/api/notify/telegram', async () => {
    const st = await telegram.settings();
    return {
      ...st,
      token: st.token ? `${st.token.slice(0, 6)}...` : '',
      tokenSet: Boolean(st.token),
      lastRoute: telegram.lastRoute,
    };
  });

  app.put('/api/notify/telegram', async (req) => {
    const body = z
      .object({
        token: z.string().max(200).optional(),
        chatId: z.string().max(64).optional(),
        events: z
          .object({
            offline: z.boolean(),
            audit: z.boolean(),
            bans: z.boolean(),
            updates: z.boolean(),
          })
          .optional(),
        banThreshold: z.number().int().min(1).max(10_000).optional(),
        paymentDays: z.number().int().min(0).max(60).optional(),
      })
      .parse(req.body ?? {});
    // пустой токен с формы = "не менять"; явное удаление токена - пустая строка через clearToken
    if (body.token === '') body.token = undefined;
    await telegram.save(body);
    return { ok: true };
  });

  app.post('/api/notify/telegram/clear', async () => {
    await telegram.save({ token: '', chatId: '' });
    return { ok: true };
  });

  /** Кто писал боту: список чатов для подбора chat id (токен можно передать с формы). */
  app.post('/api/notify/telegram/detect', async (req, reply) => {
    const body = z.object({ token: z.string().max(200).optional() }).parse(req.body ?? {});
    const r = await telegram.detectChats(body.token?.trim() || undefined);
    if (r.err) return reply.code(502).send({ error: r.err });
    return { chats: r.chats ?? [] };
  });

  app.post('/api/notify/telegram/test', async (_req, reply) => {
    const err = await telegram.send('VPS Panel: тестовое сообщение, уведомления работают.');
    if (err) return reply.code(502).send({ error: err });
    return { ok: true };
  });
}
