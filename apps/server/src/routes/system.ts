import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { loadPanelKey } from '../lib/ssh.js';
import { SshPublicKey } from '../lib/validate.js';

const Id = z.object({ id: z.string() });

/** Система сервера: обновление пакетов, ключи SSH root, перезагрузка. */
export async function systemRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, env, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);

  app.post('/api/servers/:id/upgrade', async (req) => {
    const { id } = Id.parse(req.params);
    return { actionId: await runStreamed(id, 'system.upgrade', 'system.upgrade', {}, 40 * 60_000) };
  });
  /** Добавить ключи в authorized_keys root: свои (вставленные) и/или ключ панели. */
  app.post('/api/servers/:id/ssh-keys', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        keys: z.array(z.string().trim().max(4000).pipe(SshPublicKey)).max(50).default([]),
        panelKey: z.boolean().default(false),
      })
      .parse(req.body);
    const keys = body.keys.map((k) => k.trim()).filter(Boolean);
    if (body.panelKey) keys.push(loadPanelKey(env.DATA_DIR).publicKey);
    if (keys.length === 0) return reply.code(400).send({ error: 'нет ни одного ключа' });
    return quickAction<{ added: number }>(id, 'ssh.keys.add', 'ssh.keys.add', { keys }, 30_000);
  });
  /** Ключи root на сервере (чтение, не действие); ключ панели помечен. */
  app.get('/api/servers/:id/ssh-keys', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
    const res: { keys: { fingerprint: string; panel?: boolean }[]; passwordLogin: boolean } =
      await registry.request(id, 'ssh.keys.list', {}, { timeoutMs: 30_000 });
    // отпечаток как у ssh-keygen -l: sha256 от тела ключа, base64 без "="
    const blob = loadPanelKey(env.DATA_DIR).publicKey.split(/\s+/)[1] ?? '';
    const panelFp = `SHA256:${createHash('sha256').update(Buffer.from(blob, 'base64')).digest('base64').replace(/=+$/, '')}`;
    for (const k of res.keys) k.panel = k.fingerprint === panelFp;
    return res;
  });
  const Fingerprint = z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/);
  /** Удалить ключ root по отпечатку; последний ключ без входа по паролю агент не удалит. */
  app.post('/api/servers/:id/ssh-keys/remove', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ fingerprint: Fingerprint }).parse(req.body ?? {});
    return quickAction<{ ok: boolean }>(id, 'ssh.keys.remove', 'ssh.keys.remove', body, 30_000);
  });
  /** Комментарий ключа root (третье поле строки authorized_keys); пустой - убрать. */
  app.post('/api/servers/:id/ssh-keys/comment', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({ fingerprint: Fingerprint, comment: z.string().trim().max(200) })
      .parse(req.body ?? {});
    return quickAction<{ ok: boolean }>(id, 'ssh.keys.comment', 'ssh.keys.comment', body, 30_000);
  });
  app.post('/api/servers/:id/reboot', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const row = (
      await db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    const { confirmName } = z.object({ confirmName: z.string() }).parse(req.body);
    if (confirmName !== row.name)
      return reply.code(400).send({ error: 'имя сервера не совпадает' });
    await quickAction(id, 'system.reboot', 'system.reboot', {}, 15_000);
    return { ok: true };
  });
}
