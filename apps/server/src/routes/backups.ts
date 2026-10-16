import { createHash } from 'node:crypto';
import {
  chmodSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { backups, servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { readArchiveManifest } from '../lib/backup-archive.js';
import type { BackupRestorer } from '../lib/backup-restore.js';
import type { BackupSetup } from '../lib/backup-setup.js';
import { newId } from '../lib/ids.js';
import { encryptedSize, opensslDecryptStream, opensslEncryptStream } from '../lib/panel-backup.js';
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
  opts: {
    db: Db;
    env: Env;
    registry: AgentRegistry;
    hub: UiHub;
    restorer: BackupRestorer;
    /** Пароль резервных копий ("Настройки" - "Резервная копия"): им шифруются скачанные копии. */
    password: () => string | null;
  },
) {
  const { db, env, registry, hub, restorer, password } = opts;
  const noPassword = () =>
    Object.assign(
      new Error(
        'не задан пароль резервных копий: его нужно задать в \u00abНастройки\u00bb \u2014 \u00abРезервная копия панели\u00bb',
      ),
      { statusCode: 409, code: 'no-password' },
    );
  const journal = actionJournal(db, hub, registry);
  const dir = join(env.DATA_DIR, 'backups');
  // 700: без x каталог не открыть (с 600 загрузка бэкапа падает с EACCES), без
  // доступа для чужих - в архивах секреты серверов
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = (id: string) => join(dir, `${id}.tar.gz`);
  // копии удалённых серверов (до того, как их стали удалять вместе с сервером) - убрать
  for (const b of db
    .select({ id: backups.id })
    .from(backups)
    .where(isNull(backups.serverId))
    .all()) {
    if (existsSync(file(b.id))) unlinkSync(file(b.id));
    db.delete(backups).where(eq(backups.id, b.id)).run();
  }

  app.addContentTypeParser(
    ['application/gzip', 'application/octet-stream'],
    (_req, payload, done) => done(null, payload),
  );

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
    const row = db.select({ id: servers.id }).from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    const action = journal.open(id, 'backup.create', { components });
    const backupId = newId();
    const done = restorer.create(id, components, action.stream, backupId);
    void done
      .then(async () => {
        hub.broadcast({ type: 'server.changed', serverId: id });
        await action.finish(0);
      })
      .catch((e: Error) => {
        action.stream('stderr', `\nОШИБКА: ${e.message}\n`);
        void action.finish(1);
      });
    return { actionId: action.id, backupId };
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
        const { token } = req.params as { token: string };
        const u = restorer.upload(token);
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
      const u = restorer.upload(token);
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

  /**
   * Загрузить файл копии (скачанный раньше): он становится копией этого сервера, и настройка
   * сервера разворачивает его. Нужен manifest.json с составом сервисов - он есть в копиях с
   * версии 1.6.
   */
  app.post(
    '/api/servers/:id/backups/upload',
    {
      bodyLimit: MAX_BACKUP_BYTES,
      onRequest: async (req, reply) => {
        const type = String(req.headers['content-type'] ?? '');
        if (!type.startsWith('application/gzip') && !type.startsWith('application/octet-stream'))
          return reply.code(415).send({ error: 'нужен файл резервной копии' });
        if (Number(req.headers['content-length'] ?? 0) > MAX_BACKUP_BYTES)
          return reply.code(413).send({ error: 'архив больше 2\u00a0ГБ' });
      },
    },
    async (req) => {
      const { id } = z.object({ id: z.string() }).parse(req.params);
      const row = db.select({ id: servers.id }).from(servers).where(eq(servers.id, id)).get();
      if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
      const backupId = newId();
      const raw = `${file(backupId)}.upload`;
      let bytes = 0;
      const count = new Transform({
        transform(d: Buffer, _enc, cb) {
          bytes += d.length;
          if (bytes > MAX_BACKUP_BYTES)
            return cb(Object.assign(new Error('архив больше 2\u00a0ГБ'), { statusCode: 413 }));
          cb(null, d);
        },
      });
      const drop = () => {
        for (const f of [raw, file(backupId)]) if (existsSync(f)) unlinkSync(f);
      };
      const hash = createHash('sha256');
      const hashed = new Transform({
        transform(d: Buffer, _enc, cb) {
          hash.update(d);
          cb(null, d);
        },
      });
      try {
        await pipeline(
          req.body as NodeJS.ReadableStream,
          count,
          createWriteStream(raw, { mode: 0o600 }),
        );
        // скачанная копия зашифрована паролем резервных копий; старый незашифрованный файл -
        // как есть. В панели копия хранится расшифрованной (как созданная агентом).
        const head = await readHead(raw, 16);
        if (head.subarray(0, 8).toString() === 'Salted__') {
          const pass = password();
          if (!pass) throw noPassword();
          try {
            await pipeline(
              createReadStream(raw, { start: 16 }),
              opensslDecryptStream(head, pass),
              hashed,
              createWriteStream(file(backupId), { mode: 0o600 }),
            );
          } catch {
            throw Object.assign(
              new Error(
                'не удалось расшифровать: копия зашифрована другим паролем или файл повреждён',
              ),
              { statusCode: 400 },
            );
          }
        } else {
          await pipeline(
            createReadStream(raw),
            hashed,
            createWriteStream(file(backupId), { mode: 0o600 }),
          );
        }
        unlinkSync(raw);
      } catch (e) {
        drop();
        throw e;
      }
      const man = await readArchiveManifest(file(backupId));
      const comps = Array.isArray(man?.components) ? man.components : null;
      const setup = man?.setup && typeof man.setup === 'object' ? (man.setup as BackupSetup) : null;
      if (!man || !comps) {
        drop();
        throw Object.assign(
          new Error('это не резервная копия сервера: в архиве нет manifest.json'),
          {
            statusCode: 400,
          },
        );
      }
      if (!setup || !Array.isArray(setup.services)) {
        drop();
        throw Object.assign(
          new Error('в копии нет состава сервисов: она сделана до версии 1.6, нужна новая копия'),
          { statusCode: 400 },
        );
      }
      await db.insert(backups).values({
        id: backupId,
        serverId: id,
        serverName: String(setup.serverName || man.hostname || ''),
        hostname: String(man.hostname ?? ''),
        createdAt: typeof man.createdAt === 'string' ? man.createdAt : new Date().toISOString(),
        size: statSync(file(backupId)).size,
        sha256: hash.digest('hex'),
        manifest: { components: comps, setup },
      });
      hub.broadcast({ type: 'server.changed', serverId: id });
      return { id: backupId };
    },
  );

  /** Скачать бэкап себе (по сессии). */
  app.get('/api/backups/:bid/download', async (req, reply) => {
    const { bid } = z.object({ bid: z.string() }).parse(req.params);
    const row = (await db.select().from(backups).where(eq(backups.id, bid)).limit(1))[0];
    if (!row || !existsSync(file(bid)))
      return reply.code(404).send({ error: 'резервная копия не найдена' });
    // файл уходит с панели на компьютер владельца - зашифрованным: в архиве ключи серверов и
    // клиентов. Формат openssl: openssl enc -d -aes-256-cbc -pbkdf2 -iter 100000
    const pass = password();
    if (!pass) throw noPassword();
    const name =
      `${row.serverName || row.hostname || 'server'}-${row.createdAt.slice(0, 10)}.tar.gz.enc`.replace(
        /[^\w.-]+/g,
        '_',
      );
    const enc = opensslEncryptStream(pass);
    const out = new PassThrough();
    out.write(enc.header);
    void pipeline(createReadStream(file(bid)), enc.cipher, out).catch(() => out.destroy());
    reply.header('content-disposition', `attachment; filename="${name}"`);
    reply.header('content-length', String(encryptedSize(statSync(file(bid)).size)));
    reply.header('cache-control', 'no-store');
    reply.type('application/octet-stream');
    return reply.send(out);
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

/** Первые n байт файла. */
async function readHead(path: string, n: number): Promise<Buffer> {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(n);
    const { bytesRead } = await fh.read(buf, 0, n, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}
