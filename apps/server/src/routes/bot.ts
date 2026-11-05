import type { BotLink, BotView } from '@vps/protocol';
import type { FastifyInstance } from 'fastify';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Bot } from '../bot/index.js';
import { sha256 } from '../lib/auth.js';
import { type StepUp, hasStepUp } from '../lib/step-up.js';
import { sessionToken } from './auth.js';

/** Управление через Telegram-бота: включение, привязка и отвязка аккаунта администратора. */
export async function botRoutes(
  app: FastifyInstance,
  opts: { bot: Bot; stepUp: StepUp; secure: boolean },
) {
  const { bot, stepUp, secure } = opts;
  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    const sid = sessionToken(req);
    if (!sid || !hasStepUp(stepUp, req, secure, sha256(sid)))
      return reply
        .code(403)
        .send({ error: 'нужно подтверждение пароля и 2FA', code: 'step_up_required' });
    return null;
  };

  app.get('/api/notify/bot', async (): Promise<BotView> => bot.view());

  app.patch('/api/notify/bot', async (req, reply): Promise<BotView | undefined> => {
    if (guard(req, reply)) return;
    const body = z
      .object({ on: z.boolean().optional(), level: z.enum(['view', 'safe', 'all']).optional() })
      .parse(req.body ?? {});
    if (body.level) bot.setLevel(body.level);
    if (body.on !== undefined) await bot.setOn(body.on);
    return bot.view();
  });

  app.post('/api/notify/bot/link', async (req, reply): Promise<BotLink | undefined> => {
    if (guard(req, reply)) return;
    return bot.link();
  });

  app.post('/api/notify/bot/unbind', async (req, reply): Promise<BotView | undefined> => {
    if (guard(req, reply)) return;
    await bot.unbind();
    return bot.view();
  });
}
