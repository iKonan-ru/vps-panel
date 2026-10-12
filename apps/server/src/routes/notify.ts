import { NOTIFY_EVENTS, NOTIFY_PARAM_LIMITS, type NotifyParams } from '@vps/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Telegram } from '../lib/telegram.js';

const param = (k: keyof NotifyParams) =>
  z.number().int().min(NOTIFY_PARAM_LIMITS[k][0]).max(NOTIFY_PARAM_LIMITS[k][1]).optional();

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
      health: telegram.health(),
    };
  });

  /** Доходят ли уведомления: для плашки в каркасе панели (опрос раз в минуту). */
  app.get('/api/notify/telegram/health', async () => {
    const st = await telegram.settings();
    return { configured: Boolean(st.token && st.chatId), ...telegram.health() };
  });

  app.put('/api/notify/telegram', async (req) => {
    const body = z
      .object({
        token: z.string().max(200).optional(),
        chatId: z.string().max(64).optional(),
        // события по одному: недостающие берём из сохранённых (частичная запись)
        events: z.record(z.enum(NOTIFY_EVENTS), z.boolean()).optional(),
        mutedServers: z.array(z.string().max(64)).max(500).optional(),
        banThreshold: param('banThreshold'),
        paymentDays: param('paymentDays'),
        offlineMinutes: param('offlineMinutes'),
      })
      .parse(req.body ?? {});
    // пустой токен с формы = "не менять"; явное удаление токена - пустая строка через clearToken
    if (body.token === '') body.token = undefined;
    const events = body.events
      ? { ...(await telegram.settings()).events, ...body.events }
      : undefined;
    await telegram.save({ ...body, events });
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
    const err = await telegram.send('VPS Panel: тестовое сообщение, уведомления работают', {
      keep: false,
    });
    if (err) return reply.code(502).send({ error: err });
    return { ok: true };
  });
}
