import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sha256 } from '../lib/auth.js';
import type { PanelProxy } from '../lib/panel-proxy.js';
import { sessionOf, sessionToken } from './auth.js';

/** Поддомены панелей сервисов: ask для Caddy и вход по тикету (lib/panel-proxy.ts). */
export async function proxyRoutes(
  app: FastifyInstance,
  opts: { proxy: PanelProxy; db: Parameters<typeof sessionOf>[0] },
) {
  const { proxy, db } = opts;

  /**
   * Caddy on_demand_tls: выпускать ли сертификат на этот хост. Без входа (ходит только Caddy):
   * да - только для поддомена, который знает панель, иначе сканер из CT-логов заставил бы
   * выпускать сертификаты на что угодно.
   */
  app.get('/api/proxy/ask', async (req, reply) => {
    const { domain } = z.object({ domain: z.string().max(253) }).parse(req.query);
    const label = proxy.labelOf(domain);
    if (!label || !(await proxy.target(label))) return reply.code(404).send('no');
    return reply.send('ok');
  });

  /** Переход с панели на поддомен: тикет и редирект. Без сессии - на вход с возвратом. */
  app.get('/api/proxy/open/:label', async (req, reply) => {
    const { label } = z.object({ label: z.string().regex(/^[a-z0-9-]{1,63}$/) }).parse(req.params);
    const { back } = z.object({ back: z.string().max(2000).optional() }).parse(req.query);
    reply.header('cache-control', 'no-store');
    const token = sessionToken(req);
    if (!token || !(await sessionOf(db, token))) {
      const next = `/api/proxy/open/${label}${back ? `?back=${encodeURIComponent(back)}` : ''}`;
      return reply.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    }
    if (!(await proxy.target(label)))
      return reply.code(404).send({ error: 'Такой панели сервиса нет' });
    const q = new URLSearchParams({ t: proxy.issueTicket(label, sha256(token)) });
    if (back) q.set('back', back);
    return reply.redirect(`https://${label}.${proxy.domain}/__vps/auth?${q.toString()}`, 302);
  });
}
