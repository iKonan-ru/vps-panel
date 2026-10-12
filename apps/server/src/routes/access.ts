import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { access } from '../db/schema.js';
import { type AccessFields, FieldSchema, nextPosition, sealFields } from '../lib/access.js';
import { newId } from '../lib/ids.js';
import type { SecretBox } from '../lib/secret-box.js';

const AccessBody = z.object({
  kind: z.string().max(40).default('custom'),
  title: z.string().min(1).max(80),
  fields: z.array(FieldSchema).max(30).default([]),
  note: z.string().max(2000).default(''),
});

/**
 * Доступы к панелям и сервисам сервера: то, что записали команды установки
 * (логин, пароль, ссылка на панель, ссылки прокси), и то, что добавил пользователь.
 * Значения полей в базе зашифрованы; наружу отдаются открытыми только по этому API.
 */
/** Виды записей, которые хранятся в "Доступах", но не показываются (служебные). */
const HIDDEN_KINDS = new Set(['xui-api']);

export async function accessRoutes(app: FastifyInstance, opts: { db: Db; box: SecretBox }) {
  const { db, box } = opts;

  const open = (row: typeof access.$inferSelect) => ({
    ...row,
    fields: row.fields.map((f) => ({ ...f, value: box.open(f.value) })),
  });
  const seal = (fields: AccessFields) => sealFields(box, fields);

  app.get('/api/servers/:id/access', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const rows = await db
      .select()
      .from(access)
      .where(eq(access.serverId, id))
      .orderBy(access.position, access.createdAt);
    // токен API 3X-UI - служебный (панель ходит им в 3X-UI), в блоке "Доступы" не показывается
    return rows.filter((r) => !HIDDEN_KINDS.has(r.kind)).map(open);
  });

  /** Новый порядок записей (перетаскивание в блоке "Доступы"): ids сверху вниз. */
  app.put('/api/servers/:id/access/order', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const { ids } = z.object({ ids: z.array(z.string()).max(500) }).parse(req.body ?? {});
    db.transaction((tx) => {
      ids.forEach((aid, position) => {
        tx.update(access)
          .set({ position })
          .where(and(eq(access.id, aid), eq(access.serverId, id)))
          .run();
      });
    });
    return { ok: true };
  });

  app.post('/api/servers/:id/access', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const body = AccessBody.parse(req.body ?? {});
    const row = {
      id: newId(),
      serverId: id,
      ...body,
      fields: seal(body.fields),
      position: await nextPosition(db, id),
    };
    await db.insert(access).values(row);
    return open({ ...row, createdAt: '', updatedAt: '' });
  });

  app.patch('/api/servers/:id/access/:aid', async (req, reply) => {
    const { id, aid } = z.object({ id: z.string(), aid: z.string() }).parse(req.params);
    const body = AccessBody.partial().parse(req.body ?? {});
    const patch: Partial<typeof access.$inferInsert> = { updatedAt: new Date().toISOString() };
    if (body.title !== undefined) patch.title = body.title;
    if (body.kind !== undefined) patch.kind = body.kind;
    if (body.note !== undefined) patch.note = body.note;
    if (body.fields !== undefined) patch.fields = seal(body.fields);
    const res = await db
      .update(access)
      .set(patch)
      .where(and(eq(access.id, aid), eq(access.serverId, id)))
      .returning();
    if (!res[0]) return reply.code(404).send({ error: 'запись не найдена' });
    return open(res[0]);
  });

  app.delete('/api/servers/:id/access/:aid', async (req) => {
    const { id, aid } = z.object({ id: z.string(), aid: z.string() }).parse(req.params);
    await db.delete(access).where(and(eq(access.id, aid), eq(access.serverId, id)));
    return { ok: true };
  });
}
