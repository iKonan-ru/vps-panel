import { isIP } from 'node:net';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { firewallRules, portsyncConfigs } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { newId } from '../lib/ids.js';
import { PortsyncConfig } from '../lib/validate.js';

const Id = z.object({ id: z.string() });

/** Эталон сервера (план и применение) и firewall: включение, port-sync, ручные правила. */
export async function baselineFirewallRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);

  app.post('/api/servers/:id/baseline/plan', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    return registry.request(id, 'baseline.plan', {}, { timeoutMs: 120_000 });
  });
  /** Исправление проблем: steps - какие шаги плана применить (пусто = все нужные). */
  app.post('/api/servers/:id/baseline/apply', async (req) => {
    const { id } = Id.parse(req.params);
    const { steps } = z
      .object({ steps: z.array(z.string().max(40)).max(20).default([]) })
      .parse(req.body ?? {});
    const actionId = await runStreamed(
      id,
      'baseline.apply',
      'baseline.apply',
      { steps },
      20 * 60_000,
    );
    return { actionId };
  });

  // ---- firewall
  app.post('/api/servers/:id/firewall/enable', async (req) => {
    const { id } = Id.parse(req.params);
    return {
      actionId: await runStreamed(id, 'firewall.enable', 'firewall.enable', {}, 5 * 60_000),
    };
  });
  app.post('/api/servers/:id/firewall/disable', async (req) => {
    const { id } = Id.parse(req.params);
    const { restartDocker } = z
      .object({ restartDocker: z.boolean().default(false) })
      .parse(req.body ?? {});
    return {
      actionId: await runStreamed(
        id,
        'firewall.disable',
        'firewall.disable',
        { restartDocker },
        5 * 60_000,
      ),
    };
  });
  app.post('/api/servers/:id/firewall/portsync/run', async (req) => {
    const { id } = Id.parse(req.params);
    return quickAction(id, 'portsync.run', 'firewall.portsync.run', {}, 120_000);
  });
  app.get('/api/servers/:id/firewall/portsync', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const row = (
      await db.select().from(portsyncConfigs).where(eq(portsyncConfigs.serverId, id)).limit(1)
    )[0];
    if (row) return row.config;
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    return registry.request(id, 'firewall.portsync.config', {}, { timeoutMs: 30_000 });
  });
  app.put('/api/servers/:id/firewall/portsync', async (req) => {
    const { id } = Id.parse(req.params);
    const config = PortsyncConfig.parse(req.body);
    await db
      .insert(portsyncConfigs)
      .values({ serverId: id, config })
      .onConflictDoUpdate({ target: portsyncConfigs.serverId, set: { config } });
    return quickAction(id, 'portsync.config', 'firewall.portsync.config', { config }, 120_000);
  });

  app.get('/api/servers/:id/firewall/rules', async (req) => {
    const { id } = Id.parse(req.params);
    return db
      .select()
      .from(firewallRules)
      .where(eq(firewallRules.serverId, id))
      .orderBy(firewallRules.createdAt);
  });
  /** Источник правила: any, IP или подсеть - строка уходит агенту в команду ufw. */
  const RuleSource = z
    .string()
    .trim()
    .max(64)
    .refine((v) => {
      if (v === 'any') return true;
      const [ip = '', mask, ...rest] = v.split('/');
      const ver = isIP(ip);
      if (!ver || rest.length) return false;
      return (
        mask === undefined || (/^\d{1,3}$/.test(mask) && Number(mask) <= (ver === 4 ? 32 : 128))
      );
    }, 'Источник - any, IP-адрес или подсеть (например 203.0.113.0/24)');
  const RuleSchema = z.object({
    portFrom: z.number().int().min(1).max(65535),
    portTo: z.number().int().min(1).max(65535).optional(),
    proto: z.enum(['tcp', 'udp', 'any']).default('tcp'),
    source: RuleSource.default('any'),
    action: z.enum(['allow', 'deny']).default('allow'),
    comment: z.string().max(120).default(''),
  });
  app.post('/api/servers/:id/firewall/rules', async (req) => {
    const { id } = Id.parse(req.params);
    const body = RuleSchema.parse(req.body);
    const rule = {
      id: newId(),
      serverId: id,
      portFrom: body.portFrom,
      portTo: body.portTo ?? body.portFrom,
      proto: body.proto,
      source: body.source || 'any',
      action: body.action,
      comment: body.comment,
    };
    await pushRules(id, [...(await rulesOf(id)), rule]);
    await db.insert(firewallRules).values(rule);
    return { id: rule.id };
  });
  app.delete('/api/servers/:id/firewall/rules/:rid', async (req) => {
    const { id, rid } = z.object({ id: z.string(), rid: z.string() }).parse(req.params);
    await pushRules(
      id,
      (await rulesOf(id)).filter((r) => r.id !== rid),
    );
    await db
      .delete(firewallRules)
      .where(and(eq(firewallRules.serverId, id), eq(firewallRules.id, rid)));
    return { ok: true };
  });
  const rulesOf = (serverId: string) =>
    db.select().from(firewallRules).where(eq(firewallRules.serverId, serverId));
  /**
   * Набор правил - сначала на сервер, база меняется после успеха: агент не в сети, занят или
   * вернул ошибку - список в панели не расходится с тем, что стоит на сервере.
   */
  async function pushRules(
    serverId: string,
    rules: Pick<
      typeof firewallRules.$inferSelect,
      'id' | 'portFrom' | 'portTo' | 'proto' | 'source' | 'action'
    >[],
  ) {
    await quickAction(serverId, 'firewall.rules', 'firewall.rules.set', {
      rules: rules.map((r) => ({
        id: r.id,
        portFrom: r.portFrom,
        portTo: r.portTo,
        proto: r.proto,
        source: r.source,
        action: r.action,
      })),
    });
    hub.broadcast({ type: 'server.changed', serverId });
  }
}
