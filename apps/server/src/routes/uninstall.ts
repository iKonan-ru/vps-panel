import type { UninstallPlan, UninstallPrepared } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOnline } from '../agents/registry.js';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import type { ServerRouteOpts } from '../lib/action-runners.js';
import { isPanelHost, panelAddresses } from '../lib/panel-host.js';
import { removeServer } from '../lib/server-remove.js';
import { putSetting } from '../lib/settings.js';
import { changeSshPort } from '../lib/ssh-port.js';
import { loadPanelKey, sshRun } from '../lib/ssh.js';
import { type UninstallLinks, detachedKey, panelDetachServers } from '../lib/uninstall-links.js';

const Id = z.object({ id: z.string() });
const Revision = z.string().regex(/^[0-9a-f]{64}$/);
const Password = z
  .string()
  .min(12)
  .max(200)
  .regex(/^[^\r\n\0]+$/);
const HostRequest = z.object({
  revision: Revision,
  ids: z.array(z.string().min(1).max(200)).max(200),
  password: Password,
  sshPortMode: z.enum(['keep', 'reset']).default('keep'),
  externalFirewallReady: z.boolean().default(false),
});
const Request = HostRequest.extend({ confirmName: z.string(), connectionsRevision: Revision });
const DetachRequest = z.object({
  confirmName: z.string(),
  connectionsRevision: Revision,
  servers: z.array(HostRequest.extend({ id: z.string() })).max(200),
});

/** SSH-процесс переживает остановку агента. Пароль остаётся в памяти текущего запроса. */
async function clearHost(
  opts: ServerRouteOpts,
  row: typeof servers.$inferSelect,
  body: z.infer<typeof HostRequest>,
  out: (chunk: string) => void,
  detachOnly = false,
) {
  const { registry, env } = opts;
  if (body.sshPortMode === 'reset') {
    if (!body.externalFirewallReady)
      throw new Error('сначала разрешите TCP 22 во внешнем firewall');
    await changeSshPort(opts, row.id, { port: 22, externalFirewallReady: true }, out);
  }
  let prepared: UninstallPrepared | undefined;
  try {
    out('Проверка состава сервера и подготовка входа root по паролю...\n');
    prepared = await registry.request<UninstallPrepared>(
      row.id,
      'uninstall.prepare',
      { ...body, detachOnly },
      { timeoutMs: 90_000 },
    );
    if (!prepared.fingerprints.length) throw new Error('агент не передал ключи хоста SSH');
    const target = {
      host: row.host,
      port: prepared.port,
      knownFingerprint: row.hostKeyFingerprint,
      fingerprints: prepared.fingerprints,
      auth: { mode: 'password' as const, password: body.password },
    };
    out('Проверка отдельного SSH-входа с новым паролем...\n');
    const check = await sshRun(target, 'true', () => {}, 30_000);
    if (check.exitCode !== 0) throw new Error('проверка SSH-входа не прошла');
    out('Вход подтверждён. Удаление выбранных ресурсов...\n');
    const result = await sshRun(
      target,
      '/usr/local/bin/vps-agent -uninstall-run',
      out,
      30 * 60_000,
      JSON.stringify({
        revision: body.revision,
        ids: body.ids,
        token: prepared.token,
        remote: true,
        detachOnly,
        panelKey: loadPanelKey(env.DATA_DIR).publicKey,
      }),
    );
    if (result.exitCode !== 0)
      throw new Error('очистка не завершена; список выполненных шагов приведён выше');
  } catch (error) {
    if (prepared && registry.isOnline(row.id))
      await registry
        .request(row.id, 'uninstall.cancel', { token: prepared.token }, { timeoutMs: 30_000 })
        .catch(() =>
          out(
            'Не удалось подтвердить откат подготовки SSH; до начала удаления действует автоматический откат через 5 минут.\n',
          ),
        );
    throw error;
  }
}

/** Полная очистка сервера и подготовка зависимостей к снятию самой панели по SSH. */
export async function uninstallRoutes(
  app: FastifyInstance,
  opts: ServerRouteOpts & { links: UninstallLinks },
) {
  const { db, registry, env, hub, links } = opts;
  const journal = actionJournal(db, hub, registry);
  const panelHost = async (row: typeof servers.$inferSelect) =>
    isPanelHost(row.host, row.statusCache?.inventory, await panelAddresses(env.PANEL_PUBLIC_URL));

  app.get('/api/servers/:id/uninstall', async (req, reply): Promise<UninstallPlan | unknown> => {
    const { id } = Id.parse(req.params);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    if (await panelHost(row)) {
      const connections = links.plan(id, true);
      const detachServers: NonNullable<UninstallPlan['detachServers']> = [];
      for (const peer of panelDetachServers(db, id)) {
        if (!registry.isOnline(peer.id)) continue;
        try {
          const plan = await registry.request<UninstallPlan>(
            peer.id,
            'uninstall.scan',
            {},
            { timeoutMs: 90_000 },
          );
          if (plan.panelHost) throw new Error('сервер распознан агентом как сервер панели');
          const ids = plan.items
            .filter((i) => i.id === 'agent' || i.id === 'portsync')
            .map((i) => i.id);
          await registry.request(
            peer.id,
            'uninstall.validate',
            { revision: plan.revision, ids, detachOnly: true },
            { timeoutMs: 90_000 },
          );
          detachServers.push({ id: peer.id, name: peer.name, revision: plan.revision, ids });
        } catch (error) {
          connections.blockers.push(`${peer.name}: ${(error as Error).message}`);
        }
      }
      return {
        revision: '0'.repeat(64),
        panelHost: true,
        items: [],
        preserved: [],
        blockers: [],
        connections,
        detachServers,
      };
    }
    requireOnline(registry, id);
    const plan = await registry.request<UninstallPlan>(
      id,
      'uninstall.scan',
      {},
      { timeoutMs: 90_000 },
    );
    return { ...plan, connections: links.plan(id, plan.panelHost) };
  });

  app.post('/api/servers/:id/uninstall/connections', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = DetachRequest.parse(req.body);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    if (body.confirmName !== row.name)
      return reply.code(400).send({ error: 'имя сервера не совпадает' });
    if (!(await panelHost(row)))
      return reply
        .code(409)
        .send({ error: 'отдельное снятие связей предназначено для сервера панели' });
    const peers = panelDetachServers(db, id);
    if (
      body.servers.length !== peers.length ||
      new Set(body.servers.map((p) => p.id)).size !== peers.length ||
      peers.some((p) => !body.servers.some((r) => r.id === p.id))
    )
      return reply
        .code(409)
        .send({ error: 'состав подключённых серверов изменился; повторите проверку' });
    const actionId = journal.background(id, 'server.detach', {}, async (action) => {
      const unlock = links.lock(id, body.connectionsRevision, true);
      const out = (chunk: string) => action.stream('log', chunk);
      let ok = false;
      try {
        for (const peer of body.servers)
          await registry.request(
            peer.id,
            'uninstall.validate',
            { revision: peer.revision, ids: peer.ids, detachOnly: true },
            { timeoutMs: 90_000 },
          );
        await links.detach(id, (line) => out(`${line}\n`), true);
        for (const peer of peers) {
          out(`Отвязка сервера: ${peer.name}\n`);
          const request = body.servers.find((p) => p.id === peer.id);
          if (!request) throw new Error('нет подтверждённого плана сервера');
          await clearHost(opts, peer, request, out, true);
          db.update(servers)
            .set({ agentTokenHash: null, registrationToken: null, registrationExpiresAt: null })
            .where(eq(servers.id, peer.id))
            .run();
          const current = db.select().from(servers).where(eq(servers.id, peer.id)).get();
          putSetting(db, detachedKey(peer.id), `${peer.host}:${current?.sshPort ?? peer.sshPort}`);
          registry.get(peer.id)?.ws.close(4005, 'panel detached');
          hub.broadcast({ type: 'server.changed', serverId: peer.id });
        }
        putSetting(db, 'uninstall_panel_server_id', id);
        out('Связи сняты. Очистку сервера панели можно продолжить по SSH.\n');
        ok = true;
      } finally {
        await unlock(ok);
      }
    });
    return { actionId };
  });

  app.post('/api/servers/:id/uninstall', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = Request.parse(req.body);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    if (body.confirmName !== row.name)
      return reply.code(400).send({ error: 'имя сервера не совпадает' });
    if (await panelHost(row))
      return reply
        .code(409)
        .send({ error: 'сервер панели очищается по SSH: vps-panel uninstall --full' });
    requireOnline(registry, id);
    const actionId = journal.background(
      id,
      'server.uninstall',
      { ids: body.ids },
      async (action) => {
        const out = (chunk: string) => action.stream('log', chunk);
        const unlock = links.lock(id, body.connectionsRevision);
        let success = false;
        try {
          await registry.request(
            id,
            'uninstall.validate',
            { revision: body.revision, ids: body.ids },
            { timeoutMs: 90_000 },
          );
          out('Снятие связей с другими серверами...\n');
          await links.detach(id, (line) => out(`${line}\n`));
          await clearHost(opts, row, body, out);
          removeServer({ db, env, registry, hub }, id);
          out('Сервер удалён из панели.\n');
          success = true;
        } finally {
          await unlock(success);
        }
      },
    );
    return { actionId };
  });
}
