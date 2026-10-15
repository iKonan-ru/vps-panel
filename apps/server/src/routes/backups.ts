import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { backups, servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import type { BackupRestorer } from '../lib/backup-restore.js';
import { backupSnapshot } from '../lib/backup-setup.js';
import { newId } from '../lib/ids.js';
import type { UiHub } from '../lib/ui-hub.js';

/**
 * Бэкапы конфигов сервисов. Агент собирает архив и загружает его в панель по
 * одноразовому токену; восстановление на любой сервер - агент скачивает архив
 * по одноразовой ссылке. Файлы в DATA_DIR/backups/<id>.tar.gz.
 */
/** Предел архива бэкапа: тело - поток, bodyLimit Fastify его не ограничивает. */
export const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

export async function backupRoutes(
  app: FastifyInstance,
  opts: { db: Db; env: Env; registry: AgentRegistry; hub: UiHub; restorer: BackupRestorer },
) {
  const { db, env, registry, hub, restorer } = opts;
  const journal = actionJournal(db, hub, registry);
  const dir = join(env.DATA_DIR, 'backups');
  // 700: без x каталог не открыть (с 600 загрузка бэкапа падает с EACCES), без
  // доступа для чужих - в архивах секреты серверов
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = (id: string) => join(dir, `${id}.tar.gz`);

  // Одноразовые токены: загрузка (агент -> панель) и скачивание (панель -> агент).
  const uploads = new Map<
    string,
    // busy - загрузка началась: второй запрос с тем же токеном не принимается;
    // sha256 - принятых байтов, ставится после загрузки
    {
      backupId: string;
      serverId: string;
      actionId: string;
      expires: number;
      busy?: boolean;
      sha256?: string;
    }
  >();
  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of uploads) if (v.expires < now) uploads.delete(k);
  };

  app.addContentTypeParser('application/gzip', (_req, payload, done) => done(null, payload));

  app.get('/api/servers/:id/backups/components', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
    return registry.request(id, 'backup.detect', {}, { timeoutMs: 60_000 });
  });

  app.get('/api/backups', async () => {
    return db.select().from(backups).orderBy(desc(backups.createdAt)).limit(200);
  });

  /** Создать: агент архивирует и загружает; действие в журнале со стримом. */
  app.post('/api/servers/:id/backups', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { components } = z
      .object({ components: z.array(z.string().max(32)).default([]) })
      .parse(req.body ?? {});
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
    const row = (
      await db.select({ name: servers.name }).from(servers).where(eq(servers.id, id)).limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    sweep();
    const backupId = newId();
    const token = randomBytes(24).toString('base64url');
    const action = journal.open(id, 'backup.create', { components });
    const actionId = action.id;
    uploads.set(token, { backupId, serverId: id, actionId, expires: Date.now() + 30 * 60_000 });
    const onStream = action.stream;
    const finish = (exitCode: number) => action.finish(exitCode);
    registry
      .request<{ sha256: string; archiveSize: number; hostname: string; components: unknown[] }>(
        id,
        'backup.create',
        {
          components,
          uploadUrl: `${env.PANEL_PUBLIC_URL}/api/agent/backups/upload/${token}`,
          token,
        },
        { timeoutMs: 20 * 60_000, onStream },
      )
      .then(async (man) => {
        const got = uploads.get(token)?.sha256;
        uploads.delete(token);
        if (!got || !existsSync(file(backupId))) {
          onStream('stderr', '\nАрхив не дошёл до панели\n');
          return finish(1);
        }
        if (got !== man.sha256) {
          unlinkSync(file(backupId));
          onStream('stderr', '\nАрхив пришёл повреждённым: контрольная сумма не совпала\n');
          return finish(1);
        }
        await db.insert(backups).values({
          id: backupId,
          serverId: id,
          serverName: row.name,
          hostname: man.hostname,
          size: statSync(file(backupId)).size,
          sha256: man.sha256,
          // что стояло на сервере: по нему настройка поставит те же сервисы на чистый сервер
          manifest: { components: man.components, setup: await backupSnapshot(db, registry, id) },
        });
        hub.broadcast({ type: 'server.changed', serverId: id });
        await finish(0);
      })
      .catch((e: Error) => {
        uploads.delete(token);
        onStream('stderr', `\nОШИБКА: ${e.message}\n`);
        void finish(1);
      });
    return { actionId, backupId };
  });

  /**
   * Приём архива от агента (без сессии: одноразовый токен). Токен и тип проверяются до
   * чтения тела: иначе без входа можно залить в память панели тело до bodyLimit.
   */
  app.post(
    '/api/agent/backups/upload/:token',
    {
      bodyLimit: MAX_BACKUP_BYTES,
      logLevel: 'warn',
      onRequest: async (req, reply) => {
        sweep();
        const { token } = req.params as { token: string };
        const u = uploads.get(token);
        const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
        if (!u || u.busy || bearer !== token)
          return reply.code(403).send({ error: 'токен загрузки недействителен' });
        if (!String(req.headers['content-type'] ?? '').startsWith('application/gzip'))
          return reply.code(415).send({ error: 'ожидается application/gzip' });
        if (Number(req.headers['content-length'] ?? 0) > MAX_BACKUP_BYTES)
          return reply.code(413).send({ error: 'архив больше 2\u00a0ГБ' });
        u.busy = true;
      },
    },
    async (req) => {
      const { token } = z.object({ token: z.string() }).parse(req.params);
      const u = uploads.get(token);
      if (!u) throw Object.assign(new Error('токен загрузки недействителен'), { statusCode: 403 });
      const hash = createHash('sha256');
      const out = createWriteStream(file(u.backupId), { mode: 0o600 });
      const body = req.body as NodeJS.ReadableStream;
      let bytes = 0;
      const count = new Transform({
        transform(d: Buffer, _enc, cb) {
          bytes += d.length;
          if (bytes > MAX_BACKUP_BYTES)
            return cb(Object.assign(new Error('архив больше 2\u00a0ГБ'), { statusCode: 413 }));
          hash.update(d);
          cb(null, d);
        },
      });
      try {
        await pipeline(body, count, out);
      } catch (e) {
        // оборванный архив не оставляем: строки в базе для него не будет
        if (existsSync(file(u.backupId))) unlinkSync(file(u.backupId));
        throw e;
      }
      u.sha256 = hash.digest('hex');
      return { ok: true, sha256: u.sha256 };
    },
  );

  /** Скачать бэкап себе (по сессии). */
  app.get('/api/backups/:bid/download', async (req, reply) => {
    const { bid } = z.object({ bid: z.string() }).parse(req.params);
    const row = (await db.select().from(backups).where(eq(backups.id, bid)).limit(1))[0];
    if (!row || !existsSync(file(bid)))
      return reply.code(404).send({ error: 'резервная копия не найдена' });
    const name =
      `${row.serverName || row.hostname || 'server'}-${row.createdAt.slice(0, 10)}.tar.gz`.replace(
        /[^\w.-]+/g,
        '_',
      );
    reply.header('content-disposition', `attachment; filename="${name}"`);
    reply.header('content-length', String(statSync(file(bid)).size));
    reply.type('application/gzip');
    return reply.send(createReadStream(file(bid)));
  });

  app.delete('/api/backups/:bid', async (req, reply) => {
    const { bid } = z.object({ bid: z.string() }).parse(req.params);
    const res = await db.delete(backups).where(eq(backups.id, bid)).returning({ id: backups.id });
    if (res.length === 0) return reply.code(404).send({ error: 'резервная копия не найдена' });
    if (existsSync(file(bid))) unlinkSync(file(bid));
    return { ok: true };
  });

  /** Восстановить на сервер: агент скачивает архив по одноразовой ссылке. */
  app.post('/api/backups/:bid/restore', async (req) => {
    const { bid } = z.object({ bid: z.string() }).parse(req.params);
    const { serverId, components } = z
      .object({ serverId: z.string(), components: z.array(z.string().max(32)).default([]) })
      .parse(req.body);
    const row = restorer.get(bid);
    if (!row) throw Object.assign(new Error('резервная копия не найдена'), { statusCode: 404 });
    if (!registry.isOnline(serverId))
      throw Object.assign(new Error('сервер не в сети'), { statusCode: 409 });
    const action = journal.open(serverId, 'backup.restore', {
      backupId: bid,
      from: row.serverName,
      components,
    });
    restorer
      .restore(serverId, bid, components, action.stream)
      .then(() => action.finish(0))
      .catch((e: Error) => {
        action.stream('stderr', `\nОШИБКА: ${e.message}\n`);
        void action.finish(1);
      });
    return { actionId: action.id };
  });

  // токен в адресе: в журнал контейнера запрос не пишется, в журнале Caddy он
  // замаскирован; ссылка одноразовая
  app.get('/api/agent/backups/download/:token', { logLevel: 'warn' }, async (req, reply) => {
    const { token } = z.object({ token: z.string() }).parse(req.params);
    const f = restorer.take(token);
    if (!f) return reply.code(403).send({ error: 'ссылка недействительна' });
    reply.header('content-length', String(statSync(f).size));
    reply.type('application/gzip');
    return reply.send(createReadStream(f));
  });
}
