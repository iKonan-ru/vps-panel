import { type Tag, type TagColor, TagColorSchema, nextTagColor, normTag } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { serverTags, servers } from '../db/schema.js';

/** Ключ сравнения имён: без учёта регистра и для кириллицы (nocase в SQLite - только латиница). */
const key = (s: string) => s.toLocaleLowerCase('ru');

/**
 * Теги для записи в сервер: имена приводятся к справочнику без учёта регистра, повторы убираются,
 * новые попадают в справочник с первым свободным цветом палитры.
 */
export function ensureTags(db: Db, input: readonly string[]): string[] {
  return db.transaction((tx) => {
    const all = tx.select().from(serverTags).all();
    const byKey = new Map(all.map((t) => [key(t.name), t.name]));
    const used = all.map((t) => t.color);
    const out: string[] = [];
    for (const raw of input) {
      const n = normTag(raw);
      if (!n) continue;
      let name = byKey.get(key(n));
      if (!name) {
        const color = nextTagColor(used);
        used.push(color);
        tx.insert(serverTags).values({ name: n, color }).run();
        byKey.set(key(n), n);
        name = n;
      }
      if (!out.includes(name)) out.push(name);
    }
    return out;
  });
}

/** Справочник с числом серверов у каждого тега, по алфавиту. */
export function listTags(db: Db): Tag[] {
  const count = new Map<string, number>();
  for (const s of db.select({ tags: servers.tags }).from(servers).all())
    for (const t of s.tags) count.set(key(t), (count.get(key(t)) ?? 0) + 1);
  return db
    .select()
    .from(serverTags)
    .all()
    .map((t) => {
      const c = TagColorSchema.safeParse(t.color);
      return {
        name: t.name,
        color: c.success ? c.data : 'slate',
        servers: count.get(key(t.name)) ?? 0,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Заменить тег на серверах (to = null - убрать); ид серверов, где он стоял. */
function replaceOnServers(
  tx: Parameters<Parameters<Db['transaction']>[0]>[0],
  from: string,
  to: string | null,
) {
  const ids: string[] = [];
  for (const s of tx.select({ id: servers.id, tags: servers.tags }).from(servers).all()) {
    if (!s.tags.some((t) => key(t) === key(from))) continue;
    const tags = [
      ...new Set(s.tags.flatMap((t) => (key(t) === key(from) ? (to === null ? [] : [to]) : [t]))),
    ];
    tx.update(servers).set({ tags }).where(eq(servers.id, s.id)).run();
    ids.push(s.id);
  }
  return ids;
}

/**
 * Новое имя или цвет тега. Имя другого тега из справочника - слияние: тег исчезает, на его
 * серверах остаётся тот. null - тега нет; иначе ид серверов, у которых поменялись теги.
 */
export function updateTag(
  db: Db,
  name: string,
  patch: { name?: string | undefined; color?: TagColor | undefined },
): string[] | null {
  return db.transaction((tx) => {
    const all = tx.select().from(serverTags).all();
    const cur = all.find((t) => key(t.name) === key(name));
    if (!cur) return null;
    const next = patch.name === undefined ? cur.name : normTag(patch.name);
    if (next === cur.name) {
      if (patch.color)
        tx.update(serverTags)
          .set({ color: patch.color })
          .where(eq(serverTags.name, cur.name))
          .run();
      return [];
    }
    const other = all.find((t) => t !== cur && key(t.name) === key(next));
    if (other) {
      tx.delete(serverTags).where(eq(serverTags.name, cur.name)).run();
    } else {
      tx.update(serverTags)
        .set({ name: next, ...(patch.color ? { color: patch.color } : {}) })
        .where(eq(serverTags.name, cur.name))
        .run();
    }
    return replaceOnServers(tx, cur.name, other?.name ?? next);
  });
}

/** Удалить тег из справочника и со всех серверов; null - тега нет. */
export function removeTag(db: Db, name: string): string[] | null {
  return db.transaction((tx) => {
    const cur = tx
      .select()
      .from(serverTags)
      .all()
      .find((t) => key(t.name) === key(name));
    if (!cur) return null;
    tx.delete(serverTags).where(eq(serverTags.name, cur.name)).run();
    return replaceOnServers(tx, cur.name, null);
  });
}
