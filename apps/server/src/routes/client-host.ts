import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { gclientBindings, servers } from '../db/schema.js';
import { checkClientHost } from '../lib/client-host.js';
import { type GClients, queued } from '../lib/gclients.js';
import { slugify } from '../lib/panel-proxy.js';
import type { UiHub } from '../lib/ui-hub.js';

const Id = z.object({ id: z.string() });
const Name = z.object({ name: z.string().trim().toLowerCase().max(253) });

/**
 * Адрес сервера в конфигах людей (lib/client-host.ts): имя под A-записью вместо IP. Сохраняется
 * только имя, которое у публичных резолверов указывает на этот сервер; после смены - сверка
 * привязок сервера (ссылки и конфиги на личных страницах перевыпускаются с новым адресом).
 */
export async function clientHostRoutes(
  app: FastifyInstance,
  opts: { db: Db; gc: GClients; hub: UiHub; panelUrl: string },
) {
  const { db, gc, hub } = opts;
  const row = (id: string) => db.select().from(servers).where(eq(servers.id, id)).get();

  app.get('/api/servers/:id/client-host', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const r = row(id);
    if (!r) return reply.code(404).send({ error: 'Сервер не найден' });
    // подсказка: имя прокси для браузера (A-запись уже есть) или <слаг>.<домен панели>
    const inv = (r.statusCache as StatusCache | null)?.inventory;
    const naive = inv?.services.find((s) => s.kind === 'naive')?.details?.domain;
    const domain = new URL(opts.panelUrl).hostname;
    return {
      host: r.host,
      clientHost: r.clientHost ?? '',
      suggestion: typeof naive === 'string' && naive ? naive : `${slugify(r.name)}.${domain}`,
    };
  });

  app.post('/api/servers/:id/client-host/check', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const r = row(id);
    if (!r) return reply.code(404).send({ error: 'Сервер не найден' });
    const { name } = Name.parse(req.body ?? {});
    return checkClientHost(name, r.host);
  });

  /** Задать имя (пусто - снова IP): имя проверяется, затем сверка привязок сервера. */
  app.put('/api/servers/:id/client-host', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const r = row(id);
    if (!r) return reply.code(404).send({ error: 'Сервер не найден' });
    const { name } = Name.parse(req.body ?? {});
    if (name) {
      const c = await checkClientHost(name, r.host);
      if (!c.ok) return reply.code(409).send({ error: c.error ?? 'имя не указывает на сервер' });
    }
    if ((r.clientHost ?? '') === name) return { ok: true, changed: false };
    db.update(servers)
      .set({ clientHost: name || null })
      .where(eq(servers.id, id))
      .run();
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, id)).run();
    gc.kick();
    hub.broadcast({ type: 'server.changed', serverId: id });
    app.log.info({ serverId: id, clientHost: name || null }, 'адрес для клиентов');
    return { ok: true, changed: true };
  });
}
