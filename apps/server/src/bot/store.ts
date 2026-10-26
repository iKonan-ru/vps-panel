import { and, eq, gt, lte } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { botState } from '../db/schema.js';

/**
 * Состояние бота, которое переживает перезапуск панели (ночное обновление, обновление из
 * бота): короткие ссылки кнопок, вид сообщений до действия, открытые экраны, действия, за
 * которыми следит бот. Запись живёт до своего срока; просроченные не читаются и удаляются
 * prune.
 */
export class BotStore {
  constructor(
    private db: Db,
    private now: () => number = () => Date.now(),
  ) {}

  private id(kind: string, key: string) {
    return `${kind}/${key}`;
  }

  get<T>(kind: string, key: string): T | null {
    const r = this.db
      .select()
      .from(botState)
      .where(eq(botState.key, this.id(kind, key)))
      .get();
    if (!r || r.expiresAt <= this.now()) return null;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return null;
    }
  }

  has(kind: string, key: string): boolean {
    return this.get(kind, key) !== null;
  }

  put(kind: string, key: string, value: unknown, ttlMs: number) {
    const row = {
      key: this.id(kind, key),
      kind,
      value: JSON.stringify(value),
      expiresAt: this.now() + ttlMs,
    };
    this.db
      .insert(botState)
      .values(row)
      .onConflictDoUpdate({
        target: botState.key,
        set: { value: row.value, expiresAt: row.expiresAt },
      })
      .run();
  }

  delete(kind: string, key: string) {
    this.db
      .delete(botState)
      .where(eq(botState.key, this.id(kind, key)))
      .run();
  }

  /** Живые записи вида kind: ключ без вида и значение. */
  list<T>(kind: string): { key: string; value: T }[] {
    const now = this.now();
    const prefix = `${kind}/`;
    return this.db
      .select()
      .from(botState)
      .where(eq(botState.kind, kind))
      .all()
      .filter((r) => r.expiresAt > now)
      .flatMap((r) => {
        try {
          return [{ key: r.key.slice(prefix.length), value: JSON.parse(r.value) as T }];
        } catch {
          return [];
        }
      });
  }

  /** Ключ живой записи вида kind с таким значением (одно значение - одна короткая ссылка). */
  keyOf(kind: string, value: unknown): string | null {
    const raw = JSON.stringify(value);
    const r = this.db
      .select({ key: botState.key })
      .from(botState)
      .where(
        and(eq(botState.kind, kind), eq(botState.value, raw), gt(botState.expiresAt, this.now())),
      )
      .get();
    if (!r) return null;
    return r.key.slice(kind.length + 1);
  }

  /** Удалить просроченное. */
  prune() {
    this.db.delete(botState).where(lte(botState.expiresAt, this.now())).run();
  }
}
