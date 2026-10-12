import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sha256 } from '../lib/auth.js';
import type { PanelCerts } from '../lib/panel-certs.js';
import type { PanelProxy } from '../lib/panel-proxy.js';
import { sessionOf, sessionToken } from './auth.js';

/** Поддомены панелей сервисов: ask для Caddy и вход по тикету (lib/panel-proxy.ts). */
export async function proxyRoutes(
  app: FastifyInstance,
  opts: {
    proxy: PanelProxy;
    db: Parameters<typeof sessionOf>[0];
    certs?: PanelCerts;
    /** IP-адрес панели (PANEL_SNI): панель без домена или её прежний адрес. */
    selfIp?: string;
  },
) {
  const { proxy, db, certs, selfIp } = opts;

  /**
   * Caddy on_demand_tls: выпускать ли сертификат на этот хост. Без входа (ходит только Caddy):
   * да - только для поддомена, который знает панель, иначе сканер из CT-логов заставил бы
   * выпускать сертификаты на что угодно. Ещё - имена сервисов самого сервера панели
   * (lib/panel-certs.ts): запросы к ним панель не обслуживает (PanelProxy.foreign).
   */
  app.get('/api/proxy/ask', async (req, reply) => {
    const { domain } = z.object({ domain: z.string().max(253) }).parse(req.query);
    // Свой IP панели: запрос без имени (https://<IP>: браузер, curl и агенты не передают SNI для
    // адреса) Caddy ведёт по правилу on_demand, хотя сертификат на IP уже выпущен. Отказ здесь рвал
    // рукопожатие; разрешение - Caddy берёт готовый сертификат из хранилища, ничего не выпуская.
    if (selfIp && domain === selfIp) return reply.send('ok');
    if (certs && (await certs.allowed(domain))) return reply.send('ok');
    const label = proxy.labelOf(domain);
    if (!label || !(await proxy.target(label))) return reply.code(404).send('no');
    return reply.send('ok');
  });

  /**
   * Переход с панели на поддомен. Без сессии - на вход с возвратом. Сначала - страница
   * "Открываю панель" (/open/<метка> интерфейса): она проверяет агента, канал и панель сервиса
   * (POST /api/proxy/probe) и возвращается сюда с go=1 - тогда тикет и редирект на поддомен.
   */
  app.get('/api/proxy/open/:label', async (req, reply) => {
    const { label } = z.object({ label: z.string().regex(/^[a-z0-9-]{1,63}$/) }).parse(req.params);
    const { back, go } = z
      .object({ back: z.string().max(2000).optional(), go: z.literal('1').optional() })
      .parse(req.query);
    reply.header('cache-control', 'no-store');
    const token = sessionToken(req);
    if (!token || !(await sessionOf(db, token))) {
      const next = `/api/proxy/open/${label}${back ? `?back=${encodeURIComponent(back)}` : ''}`;
      return reply.redirect(`/login?next=${encodeURIComponent(next)}`, 302);
    }
    if (!(await proxy.target(label)))
      return reply.code(404).send({ error: 'Такой панели сервиса нет' });
    if (!go) {
      const q = back ? `?back=${encodeURIComponent(back)}` : '';
      return reply.redirect(`/open/${label}${q}`, 302);
    }
    const q = new URLSearchParams({ t: proxy.issueTicket(label, sha256(token)) });
    if (back) q.set('back', back);
    return reply.redirect(`https://${label}.${proxy.domain}/__vps/auth?${q.toString()}`, 302);
  });

  /** Проверка перед входом на поддомен: агент, канал до порта панели, ответ панели. */
  app.post('/api/proxy/probe/:label', async (req) => {
    const { label } = z.object({ label: z.string().regex(/^[a-z0-9-]{1,63}$/) }).parse(req.params);
    return proxy.probe(label);
  });
}
