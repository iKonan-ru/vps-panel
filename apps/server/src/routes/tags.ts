import { TAG_MAX, type Tag, TagColorSchema, normTag } from '@vps/protocol';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { listTags, removeTag, updateTag } from '../lib/tags.js';
import type { UiHub } from '../lib/ui-hub.js';

const NameQuery = z.object({
  name: z
    .string()
    .min(1)
    .max(TAG_MAX * 2),
});

const PatchSchema = z.object({
  name: z
    .string()
    .max(TAG_MAX * 2)
    .optional(),
  color: TagColorSchema.optional(),
});

/** Справочник тегов серверов: список, новое имя или цвет, удаление со всех серверов. */
export async function tagRoutes(app: FastifyInstance, opts: { db: Db; hub: UiHub }) {
  const { db, hub } = opts;
  const changed = (ids: string[]) => {
    for (const id of ids) hub.broadcast({ type: 'server.changed', serverId: id });
  };

  app.get('/api/tags', async (): Promise<Tag[]> => listTags(db));

  app.patch('/api/tags', async (req, reply) => {
    const { name } = NameQuery.parse(req.query);
    const body = PatchSchema.parse(req.body);
    if (body.name !== undefined && !normTag(body.name))
      return reply.code(400).send({ error: 'имя тега пустое' });
    const ids = updateTag(db, name, body);
    if (!ids) return reply.code(404).send({ error: 'тег не найден' });
    changed(ids);
    return { ok: true };
  });

  app.delete('/api/tags', async (req, reply) => {
    const { name } = NameQuery.parse(req.query);
    const ids = removeTag(db, name);
    if (!ids) return reply.code(404).send({ error: 'тег не найден' });
    changed(ids);
    return { ok: true };
  });
}
