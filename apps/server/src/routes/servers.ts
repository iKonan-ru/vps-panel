import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { HostingSchema, type ServerSummary, actionTitle } from '@vps/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import { type StatusCache, toSummary } from '../agents/state.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { actionLog, backups, servers } from '../db/schema.js';
import { installCommand, issueRegistration, latestAgentVersion } from '../lib/agent-dist.js';
import { rollPaymentDate } from '../lib/billing.js';
import { newId } from '../lib/ids.js';
import { panelAddresses } from '../lib/panel-host.js';
import type { PanelProxy } from '../lib/panel-proxy.js';
import type { UiHub } from '../lib/ui-hub.js';

const CreateSchema = z.object({
  name: z.string().min(1).max(64),
  host: z.string().min(1).max(253),
  sshPort: z.number().int().min(1).max(65535).default(22),
  tags: z.array(z.string().max(32)).default([]),
  hosting: HostingSchema.partial().optional(),
});

const PatchSchema = CreateSchema.partial();

type HostingPatch = {
  [K in keyof z.infer<typeof HostingSchema>]?: z.infer<typeof HostingSchema>[K] | undefined;
};

function hostingToRow(h: HostingPatch | undefined) {
  if (!h) return {};
  const out: Partial<typeof servers.$inferInsert> = {};
  if (h.provider !== undefined) out.provider = h.provider;
  if (h.providerServerName !== undefined) out.providerServerName = h.providerServerName;
  if (h.providerUrl !== undefined) out.providerUrl = h.providerUrl;
  if (h.country !== undefined) out.country = h.country;
  if (h.price !== undefined) out.price = h.price;
  if (h.currency !== undefined) out.currency = h.currency;
  if (h.billingMonths !== undefined) out.billingMonths = h.billingMonths;
  if (h.nextPaymentAt !== undefined) {
    // сегодняшняя или прошедшая дата сразу становится следующей, не дожидаясь часовой проверки
    const rolled =
      h.nextPaymentAt && h.billingMonths ? rollPaymentDate(h.nextPaymentAt, h.billingMonths) : null;
    out.nextPaymentAt = rolled ?? h.nextPaymentAt;
  }
  if (h.notes !== undefined) out.notes = h.notes;
  return out;
}

export async function serverRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; env: Env; hub: UiHub; proxy?: PanelProxy },
) {
  const { db, registry, env, hub, proxy } = opts;
  const withLinks = (s: ServerSummary): ServerSummary =>
    proxy ? { ...s, panelLinks: proxy.links(s.id, s.name, s.services) } : s;

  const panelIps = () => panelAddresses(env.PANEL_PUBLIC_URL);

  app.get('/api/servers', async (): Promise<ServerSummary[]> => {
    const rows = await db.select().from(servers).orderBy(servers.name);
    const latest = latestAgentVersion(env.AGENT_DIR);
    const ips = await panelIps();
    return rows.map((r) => withLinks(toSummary(r, registry, latest, ips)));
  });

  app.post('/api/servers', async (req, reply) => {
    const body = CreateSchema.parse(req.body);
    const id = newId();
    await db.insert(servers).values({
      id,
      name: body.name,
      host: body.host,
      sshPort: body.sshPort,
      tags: body.tags,
      ...hostingToRow(body.hosting),
    });
    const registrationToken = (await issueRegistration(db, id)) ?? '';
    return reply
      .code(201)
      .send({ id, registrationToken, installCommand: installCommand(env, registrationToken) });
  });

  app.get('/api/servers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const row = (await db.select().from(servers).where(eq(servers.id, id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    const cache = (row.statusCache ?? {}) as StatusCache;
    // незавершённые действия: после перезагрузки страницы их вывод показывается снова
    const activeActions = (
      await db
        .select({
          id: actionLog.id,
          kind: actionLog.kind,
          params: actionLog.params,
          startedAt: actionLog.startedAt,
        })
        .from(actionLog)
        .where(and(eq(actionLog.serverId, id), isNull(actionLog.finishedAt)))
        .orderBy(actionLog.startedAt)
    ).map(({ params, ...a }) => ({ ...a, title: actionTitle(a.kind, params) }));
    // после действия агент присылает свежее состояние: до него кнопки действий неактивны
    if (registry.isRefreshing(id))
      activeActions.push({
        id: `refresh:${id}`,
        kind: 'status.refresh',
        title: actionTitle('status.refresh'),
        startedAt: new Date().toISOString(),
      });
    const inventory = cache.inventory ?? null;
    return {
      ...withLinks(toSummary(row, registry, latestAgentVersion(env.AGENT_DIR), await panelIps())),
      inventory,
      metricsAt: registry.latestMetrics(row.id)?.at ?? cache.metricsAt ?? null,
      activeActions,
    };
  });

  app.patch('/api/servers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = PatchSchema.parse(req.body);
    const patch: Partial<typeof servers.$inferInsert> = { ...hostingToRow(body.hosting) };
    if (body.name !== undefined) patch.name = body.name;
    if (body.host !== undefined) patch.host = body.host;
    if (body.sshPort !== undefined) patch.sshPort = body.sshPort;
    if (body.tags !== undefined) patch.tags = body.tags;
    const res = await db
      .update(servers)
      .set(patch)
      .where(eq(servers.id, id))
      .returning({ id: servers.id });
    if (res.length === 0) return reply.code(404).send({ error: 'сервер не найден' });
    hub.broadcast({ type: 'server.changed', serverId: id });
    return { ok: true };
  });

  app.delete('/api/servers/:id', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    registry.get(id)?.ws.close(4005, 'server removed');
    // резервные копии сервера - вместе с ним: файлы копий у владельца, панель их не хранит
    // без сервера
    for (const b of db
      .select({ id: backups.id })
      .from(backups)
      .where(eq(backups.serverId, id))
      .all()) {
      const f = join(env.DATA_DIR, 'backups', `${b.id}.tar.gz`);
      if (existsSync(f)) unlinkSync(f);
    }
    db.delete(backups).where(eq(backups.serverId, id)).run();
    const res = await db.delete(servers).where(eq(servers.id, id)).returning({ id: servers.id });
    if (res.length === 0) return reply.code(404).send({ error: 'сервер не найден' });
    hub.broadcast({ type: 'server.changed', serverId: id });
    return { ok: true };
  });

  /** Новый одноразовый токен и команда установки (переустановка агента). */
  app.post('/api/servers/:id/registration', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const registrationToken = await issueRegistration(db, id);
    if (!registrationToken) return reply.code(404).send({ error: 'сервер не найден' });
    return { registrationToken, installCommand: installCommand(env, registrationToken) };
  });

  /** Запросить у агента свежий снимок состояния. */
}
