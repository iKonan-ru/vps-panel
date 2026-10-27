import { AsyncLocalStorage } from 'node:async_hooks';
import { actionTitle, isBlockingAction } from '@vps/protocol';
import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';

/**
 * Незавершённое дольше этого действие сервер не держит. Страховка: действия, прерванные
 * перезапуском панели, закрываются при старте, у запросов к агенту свои таймауты. Не меньше
 * предела команды каталога у агента (4 часа) с запасом.
 */
const STALE_MS = 4 * 60 * 60_000 + 10 * 60_000;

/**
 * Кто запустил действие: запросы бота к API панели (хук onRequest в app.ts) идут внутри
 * initiator.run('telegram', ...), остальное - администратор в интерфейсе или фоновые задачи.
 */
export const initiator = new AsyncLocalStorage<string>();

/** Действие, которое сейчас занимает сервер, или null. */
export function busyAction(db: Db, serverId: string) {
  const rows = db
    .select({ kind: actionLog.kind, params: actionLog.params, startedAt: actionLog.startedAt })
    .from(actionLog)
    .where(and(eq(actionLog.serverId, serverId), isNull(actionLog.finishedAt)))
    .all();
  return (
    rows.find((r) => isBlockingAction(r.kind) && Date.now() - Date.parse(r.startedAt) < STALE_MS) ??
    null
  );
}

/**
 * Сервер занят действием или закончил его меньше ms назад: сервисы после обновления и
 * перезапуска ещё поднимаются, проверка в это время - ложная тревога.
 */
export function busyOrSettling(db: Db, serverId: string, ms: number): boolean {
  if (busyAction(db, serverId)) return true;
  const since = new Date(Date.now() - ms).toISOString();
  return db
    .select({ kind: actionLog.kind })
    .from(actionLog)
    .where(and(eq(actionLog.serverId, serverId), gt(actionLog.finishedAt, since)))
    .all()
    .some((r) => isBlockingAction(r.kind));
}

/**
 * Записывает начало действия, если сервер не занят другим; иначе ошибка 409 с названием
 * мешающего. Проверка и вставка синхронные: две одновременные попытки не проскочат обе.
 * force - без проверки (переустановка агента: ею чинят зависшего).
 */
export function beginAction(
  db: Db,
  a: { id: string; serverId: string; kind: string; params: Record<string, unknown> },
  force = false,
) {
  if (!force && isBlockingAction(a.kind)) {
    const busy = busyAction(db, a.serverId);
    if (busy)
      throw Object.assign(
        new Error(`на сервере уже выполняется: ${actionTitle(busy.kind, busy.params)}`),
        { statusCode: 409 },
      );
  }
  db.insert(actionLog)
    .values({ ...a, initiator: initiator.getStore() ?? 'admin' })
    .run();
}
