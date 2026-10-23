import type { BotLink, BotView } from '@vps/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Bot } from '../bot/index.js';

/** Управление через Telegram-бота: включение, привязка и отвязка аккаунта администратора. */
export async function botRoutes(app: FastifyInstance, opts: { bot: Bot }) {
  const { bot } = opts;

  app.get('/api/notify/bot', async (): Promise<BotView> => bot.view());

  app.patch('/api/notify/bot', async (req): Promise<BotView> => {
    const body = z
      .object({ on: z.boolean().optional(), level: z.enum(['view', 'safe', 'all']).optional() })
      .parse(req.body ?? {});
    if (body.level) bot.setLevel(body.level);
    if (body.on !== undefined) await bot.setOn(body.on);
    return bot.view();
  });

  app.post('/api/notify/bot/link', async (): Promise<BotLink> => bot.link());

  app.post('/api/notify/bot/unbind', async (): Promise<BotView> => {
    await bot.unbind();
    return bot.view();
  });
}
