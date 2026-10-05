import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { awgTunnelNames } from '../lib/awg-config.js';

const Id = z.object({ id: z.string() });
/** Имя канала - как у node-install.sh. */
export const OfChannelName = z.string().regex(/^[a-z0-9][a-z0-9-]{0,30}$/, 'имя канала');

/**
 * OpenFlux: каналы выходной ноды. Состояние, журнал и ссылка - не
 * действия (ничего не меняют); перезапуск, автообновление, обновление ядра, удаление и новый
 * канал - действия в журнале. Ключ и адреса документов в журнал не пишутся.
 */
export async function openfluxRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);
  const online = (id: string) => {
    if (!registry.isOnline(id))
      throw Object.assign(new Error('Агент не подключён'), { statusCode: 409 });
  };

  app.get('/api/servers/:id/openflux', async (req) => {
    const { id } = Id.parse(req.params);
    online(id);
    return registry.request(id, 'openflux.status', {}, { timeoutMs: 60_000 });
  });

  app.post('/api/servers/:id/openflux/logs', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({ channel: OfChannelName, lines: z.number().int().min(10).max(2000).default(200) })
      .parse(req.body ?? {});
    online(id);
    return registry.request(id, 'openflux.logs', body, { timeoutMs: 60_000 });
  });

  /** Ссылка openflux:// для приложения: в ней ключ канала, поэтому не кэшируется. */
  app.post('/api/servers/:id/openflux/link', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const { channel } = z.object({ channel: OfChannelName }).parse(req.body ?? {});
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'Сервер не найден' });
    online(id);
    reply.header('Cache-Control', 'no-store');
    return registry.request(
      id,
      'openflux.link',
      {
        channel,
        // имя профиля в приложении - как у остальных сервисов: "флаг Страна :: Хостинг"
        name: awgTunnelNames({ provider: row.provider, country: row.country, serverName: row.name })
          .title,
        host: row.host,
      },
      { timeoutMs: 60_000 },
    );
  });

  const Exec = z.discriminatedUnion('op', [
    z.object({
      op: z.enum(['restart', 'stop', 'start', 'enable', 'disable', 'remove']),
      channel: OfChannelName,
    }),
    z.object({ op: z.enum(['autoupdate-on', 'autoupdate-off', 'update']) }),
    z.object({
      op: z.literal('create'),
      channel: OfChannelName.optional(),
      // как в node-install.sh; cups.online - "auto" (комнаты создаст сервер) или список комнат
      vyandex: z
        .string()
        .trim()
        .regex(
          /^(https:\/\/(docs|disk)\.yandex\.(ru|com|by|kz|uz)\/edit\/d\/[A-Za-z0-9_-]{16,200})?$/,
          'Яндекс Документ: https://docs.yandex.ru/edit/d/...',
        )
        .default(''),
      mailru: z
        .string()
        .trim()
        .regex(
          /^(https:\/\/cloud\.mail\.ru\/public\/[A-Za-z0-9_-]{2,64}\/[A-Za-z0-9_-]{2,128})?$/,
          'Mail.ru Документ: https://cloud.mail.ru/public/.../...',
        )
        .default(''),
      cupsonline: z
        .string()
        .trim()
        .regex(/^(auto|[A-Za-z0-9_-]{8,})?$/, 'cups.online: auto или список комнат')
        .max(4096)
        .default(''),
    }),
  ]);

  app.post('/api/servers/:id/openflux/exec', async (req) => {
    const { id } = Id.parse(req.params);
    const body = Exec.parse(req.body ?? {});
    const kind = `openflux:${body.op}`;
    if (body.op === 'create' || body.op === 'update' || body.op === 'remove') {
      // адреса документов дают доступ к каналу: в журнал - только какие транспорты заданы
      const logParams =
        body.op === 'create'
          ? {
              op: body.op,
              channel: body.channel ?? '',
              transports: [
                body.vyandex && 'vyandex',
                body.mailru && 'mailru',
                body.cupsonline && 'cupsonline',
                'direct',
              ].filter(Boolean),
            }
          : body;
      return {
        actionId: await runStreamed(id, kind, 'openflux.exec', body, 15 * 60_000, logParams),
      };
    }
    return quickAction(id, kind, 'openflux.exec', body, 120_000);
  });
}
