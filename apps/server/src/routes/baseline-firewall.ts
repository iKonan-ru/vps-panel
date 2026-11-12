import { isIP } from 'node:net';
import {
  type BaselinePlan,
  type PortsyncConfig as PortsyncConfigT,
  SshPortChangeSchema,
} from '@vps/protocol';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOnline } from '../agents/registry.js';
import { firewallRules, portsyncConfigs, servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { newId } from '../lib/ids.js';
import { panelAddresses } from '../lib/panel-host.js';
import { changeSshPort } from '../lib/ssh-port.js';
import { PortsyncConfig } from '../lib/validate.js';

const Id = z.object({ id: z.string() });

/** Эталон сервера (план и применение) и firewall: включение, port-sync, ручные правила. */
export async function baselineFirewallRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);

  app.post('/api/servers/:id/ssh-port/pick', async (req) => {
    const { id } = Id.parse(req.params);
    return registry.request<{ port: number }>(id, 'ssh.port.pick', {});
  });
  app.post('/api/servers/:id/ssh-port', async (req) => {
    const { id } = Id.parse(req.params);
    const body = SshPortChangeSchema.parse(req.body);
    requireOnline(registry, id);
    return {
      actionId: journal.background(id, 'ssh.port', { port: body.port }, async (action) => {
        await changeSshPort(opts, id, body, (text) => action.stream('log', text));
      }),
    };
  });
  app.post('/api/servers/:id/baseline/plan', async (req) => {
    const { id } = Id.parse(req.params);
    const plan = await registry.request<BaselinePlan>(
      id,
      'baseline.plan',
      {},
      { timeoutMs: 120_000 },
    );
    if ((plan.sshPorts ?? [plan.sshPort]).includes(22)) {
      plan.steps.push({
        id: 'ssh-port',
        title: 'Изменить стандартный SSH-порт',
        needed: true,
        detail: 'Снижает шум сканирования; не заменяет ключи и fail2ban',
        ...(!registry.supports(id, 'ssh.port.prepare')
          ? { blocker: 'Сначала обновите агент' }
          : {}),
      });
      plan.canApply = true;
    }
    return plan;
  });
  app.post('/api/servers/:id/baseline/apply', async (req) => {
    const { id } = Id.parse(req.params);
    const { steps, sshPort } = z
      .object({
        steps: z.array(z.string().max(40)).max(20).default([]),
        sshPort: SshPortChangeSchema.optional(),
      })
      .parse(req.body ?? {});
    if (steps.includes('ssh-port') && !sshPort)
      throw new Error('выберите SSH-порт и подтвердите внешний firewall');
    requireOnline(registry, id);
    const actionId = journal.background(id, 'baseline.apply', { steps }, async (action) => {
      const normal = steps.filter((s) => s !== 'ssh-port');
      if (normal.length || steps.length === 0)
        await registry.request(
          id,
          'baseline.apply',
          { steps: normal },
          { timeoutMs: 20 * 60_000, onStream: action.stream },
        );
      if (steps.includes('ssh-port') && sshPort)
        await changeSshPort(opts, id, sshPort, (text) => action.stream('log', text));
    });
    return { actionId };
  });

  /**
   * Снять бан fail2ban с адреса (тот же fail2ban-client set <jail> unbanip, что в терминале).
   * Jail и адрес проверяются здесь: в скрипт они идут переменными окружения.
   */
  app.post('/api/servers/:id/fail2ban/unban', async (req) => {
    const { id } = Id.parse(req.params);
    const { jail, ip } = z
      .object({
        jail: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
        ip: z
          .string()
          .trim()
          .max(45)
          .refine((v) => isIP(v) !== 0, 'нужен адрес IPv4 или IPv6'),
      })
      .parse(req.body ?? {});
    requireOnline(registry, id);
    const action = journal.open(id, 'fail2ban.unban', { jail, ip });
    try {
      const r = await registry.request<{ exitCode: number }>(
        id,
        'command.run',
        {
          runId: action.id,
          script: 'set -eu\nfail2ban-client set "$JAIL" unbanip "$IP"\n',
          env: { JAIL: jail, IP: ip },
          files: {},
          cleanup: [],
          timeoutSec: 60,
        },
        { timeoutMs: 90_000, onStream: action.stream },
      );
      if (r.exitCode !== 0) {
        const tail = action.output.trim().split('\n').slice(-3).join(' ');
        throw new Error(`fail2ban-client: ${tail || `код ${r.exitCode}`}`);
      }
      await action.finish(0, `${jail}: снят бан с ${ip}`);
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message;
      await action.finish(1, msg);
      const code = (e as { statusCode?: unknown }).statusCode;
      throw Object.assign(new Error(msg), { statusCode: typeof code === 'number' ? code : 502 });
    }
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
  app.get('/api/servers/:id/firewall/portsync', async (req): Promise<PortsyncConfigT> => {
    const { id } = Id.parse(req.params);
    const row = (
      await db.select().from(portsyncConfigs).where(eq(portsyncConfigs.serverId, id)).limit(1)
    )[0];
    if (row) return row.config;
    return registry.request<PortsyncConfigT>(
      id,
      'firewall.portsync.config',
      {},
      {
        timeoutMs: 30_000,
      },
    );
  });
  app.put('/api/servers/:id/firewall/portsync', async (req) => {
    const { id } = Id.parse(req.params);
    const config = PortsyncConfig.parse(req.body);
    const save = (c: typeof config) =>
      db
        .insert(portsyncConfigs)
        .values({ serverId: id, config: c })
        .onConflictDoUpdate({ target: portsyncConfigs.serverId, set: { config: c } });
    try {
      const r = await quickAction(
        id,
        'portsync.config',
        'firewall.portsync.config',
        { config },
        120_000,
      );
      await save(config);
      return r;
    } catch (e) {
      // агент мог отказать (настройки закрыли бы работающий VPN) или принять их, а упасть на
      // запуске port-sync: в базе - то, что сейчас лежит на сервере
      const cur = PortsyncConfig.safeParse(
        await registry
          .request(id, 'firewall.portsync.config', {}, { timeoutMs: 30_000 })
          .catch(() => null),
      );
      if (cur.success) await save(cur.data);
      throw e;
    }
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
    }, 'источник: any, IP-адрес или подсеть (например, 203.0.113.0/24)');
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
  /**
   * Блокировка адреса из "Подключений": запрет всех портов с этого адреса (правило в "Своих
   * правилах" firewall, снимается там же) и сброс его соединений - ufw пропускает уже
   * установленные. Серверы панели, входы каскадов и сервер панели не блокируются.
   */
  app.post('/api/servers/:id/connections/block', async (req) => {
    const { id } = Id.parse(req.params);
    const { ip } = z.object({ ip: z.string().trim().max(64) }).parse(req.body);
    if (!isIP(ip)) throw Object.assign(new Error('неверный адрес'), { statusCode: 400 });
    const own = [
      ...(await panelAddresses(opts.env.PANEL_PUBLIC_URL)),
      ...db
        .select({ host: servers.host })
        .from(servers)
        .all()
        .map((s) => s.host),
    ];
    const view = await opts.conns.view(id, 0).catch(() => null);
    const kind = view?.addrs.find((a) => a.ip === ip)?.kind;
    if (own.includes(ip) || kind === 'server' || kind === 'cascade')
      throw Object.assign(
        new Error('это адрес сервера панели или входа каскада: блокировать нельзя'),
        {
          statusCode: 409,
        },
      );
    const rules = await rulesOf(id);
    let ruleId = rules.find(
      (r) => r.source === ip && r.action === 'deny' && r.portTo === 65535,
    )?.id;
    if (!ruleId) {
      const rule = {
        id: newId(),
        serverId: id,
        portFrom: 1,
        portTo: 65535,
        proto: 'any',
        source: ip,
        action: 'deny',
        comment: 'Блокировка из подключений',
      };
      await pushRules(id, [...rules, rule]);
      await db.insert(firewallRules).values(rule);
      ruleId = rule.id;
    }
    const killed = registry.supports(id, 'conns.kill')
      ? await registry
          .request<{ before: number; after: number }>(
            id,
            'conns.kill',
            { ip },
            { timeoutMs: 30_000 },
          )
          .catch(() => null)
      : null;
    return { ruleId, before: killed?.before ?? null, after: killed?.after ?? null };
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
