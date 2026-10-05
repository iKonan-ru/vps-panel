import { and, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { access } from '../db/schema.js';
import { newId } from './ids.js';
import type { SecretBox } from './secret-box.js';

export const FieldSchema = z.object({
  label: z.string().min(1).max(60),
  value: z.string().max(4000),
  secret: z.boolean().optional(),
});
export type AccessFields = z.infer<typeof FieldSchema>[];

/**
 * Записать доступ от команды установки: одна запись на сервер и вид сервиса,
 * повторная установка перезаписывает.
 */
export async function upsertAccess(
  db: Db,
  box: SecretBox,
  serverId: string,
  entry: { kind: string; title: string; fields: AccessFields; note?: string },
) {
  const fields = sealFields(box, entry.fields);
  const existing = (
    await db
      .select({ id: access.id })
      .from(access)
      .where(and(eq(access.serverId, serverId), eq(access.kind, entry.kind)))
      .limit(1)
  )[0];
  if (existing) {
    await db
      .update(access)
      .set({
        title: entry.title,
        fields,
        note: entry.note ?? '',
        updatedAt: new Date().toISOString(),
      })
      .where(eq(access.id, existing.id));
    return existing.id;
  }
  const id = newId();
  await db.insert(access).values({
    id,
    serverId,
    kind: entry.kind,
    title: entry.title,
    fields,
    note: entry.note ?? '',
    position: await nextPosition(db, serverId),
  });
  return id;
}

/** Новая запись встаёт в конец списка. */
export async function nextPosition(db: Db, serverId: string): Promise<number> {
  const r = await db
    .select({ p: max(access.position) })
    .from(access)
    .where(eq(access.serverId, serverId));
  return (r[0]?.p ?? -1) + 1;
}

/** Шифрует значения; secret пишется только когда true (в базе поле необязательное). */
export function sealFields(box: SecretBox, fields: AccessFields) {
  return fields.map((f) => ({
    label: f.label,
    value: box.seal(f.value),
    ...(f.secret ? { secret: true as const } : {}),
  }));
}
