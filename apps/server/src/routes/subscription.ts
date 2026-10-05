import type { FastifyInstance } from 'fastify';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { extensionVersion } from '../lib/extension.js';
import {
  buildBrowserSubscription,
  buildSubscription,
  buildWdttSubscription,
} from '../lib/subscription.js';

/** Название подписки в приложении (Happ, Hiddify): кириллица в заголовке - только base64. */
const TITLE = 'VPN';

/**
 * Подписка глобального клиента: GET /sub/<токен> без входа (вход
 * проверяется только у /api), base64 списка ссылок VLESS со всех серверов. Ответ - из кэша
 * базы. Не больше 30 запросов в минуту с адреса: токены не перебрать.
 */
export async function subscriptionRoutes(
  app: FastifyInstance,
  opts: { db: Db; env?: Pick<Env, 'EXTENSION_DIR' | 'SUB_PUBLIC_URL' | 'PANEL_PUBLIC_URL'> },
) {
  const subBase = opts.env
    ? (opts.env.SUB_PUBLIC_URL ?? opts.env.PANEL_PUBLIC_URL).replace(/\/+$/, '')
    : '';
  const opts30 = {
    logLevel: 'warn',
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  } as const;

  app.get('/sub/:token', opts30, async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.header('Cache-Control', 'no-store');
    const s = /^[0-9a-f]{32}$/.test(token) ? buildSubscription(opts.db, token) : null;
    if (!s) return reply.code(404).type('text/plain').send('not found');
    return reply
      .type('text/plain; charset=utf-8')
      .header('profile-title', `base64:${Buffer.from(TITLE).toString('base64')}`)
      .header('profile-update-interval', '12')
      .send(Buffer.from(s.links.join('\n')).toString('base64'));
  });

  /**
   * Подписка qWDTT: JSON с профилями серверов WDTT (формат приложения qWDTT); приложение
   * обновляет её само - новые серверы, пароли и хеши VK приходят без участия человека.
   */
  app.get('/sub/:token/wdtt', opts30, async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.header('Cache-Control', 'no-store');
    const s = /^[0-9a-f]{32}$/.test(token) ? buildWdttSubscription(opts.db, token) : null;
    if (!s) return reply.code(404).type('text/plain').send('not found');
    return {
      subscriptionName: TITLE,
      description: 'Серверы и пароли обновляются сами',
      updatedAt: new Date().toISOString(),
      version: 1,
      profiles: s.profiles,
    };
  });

  /**
   * Подписка расширения Chrome: JSON с прокси для браузера на каждом
   * сервере. Расширение обновляет её само; выключенный клиент - suspended, расширение снимает
   * прокси. Неизвестный токен (новая ссылка) - 404, расширение тоже снимает прокси. extension -
   * актуальная версия расширения и ссылка на архив клиента (обновление - вручную).
   */
  app.get('/sub/:token/browser', opts30, async (req, reply) => {
    const { token } = req.params as { token: string };
    reply.header('Cache-Control', 'no-store');
    const s = /^[0-9a-f]{32}$/.test(token) ? buildBrowserSubscription(opts.db, token) : null;
    if (!s) return reply.code(404).type('text/plain').send('not found');
    // актуальная версия расширения и архив клиента: расширение старее - предложит обновиться
    const v = opts.env ? extensionVersion(opts.env.EXTENSION_DIR) : null;
    const extension = v ? { version: v, download: `${subBase}/c/${token}/chrome.zip` } : undefined;
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      ...s,
      ...(extension ? { extension } : {}),
    };
  });
}
