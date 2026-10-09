import { and, eq, isNotNull, lt } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { actionLog, loginAttempts, sessions } from '../db/schema.js';
import { pruneExts } from './browser-ext.js';
import { schedule } from './schedule.js';

const DAY = 86_400_000;

/**
 * Чистка базы: журнал действий (проходы сверки клиентов - 14 дней, остальное - 180), попытки
 * входа старше 30 дней, истёкшие сессии, расширения клиентов, молчащие 60 дней. Незавершённые
 * действия не трогаются.
 */
export function prune(db: Db, now = Date.now()) {
  const before = (days: number) => new Date(now - days * DAY).toISOString();
  const done = isNotNull(actionLog.finishedAt);
  db.delete(actionLog)
    .where(and(done, eq(actionLog.kind, 'gclients.sync'), lt(actionLog.startedAt, before(14))))
    .run();
  db.delete(actionLog)
    .where(and(done, lt(actionLog.startedAt, before(180))))
    .run();
  db.delete(loginAttempts)
    .where(lt(loginAttempts.at, before(30)))
    .run();
  db.delete(sessions)
    .where(lt(sessions.expiresAt, new Date(now).toISOString()))
    .run();
  pruneExts(db, now);
}

/** Раз в сутки, первый раз - через минуту после старта. */
export function startHousekeeping(db: Db, log: { warn: (o: unknown, m?: string) => void }) {
  const run = () => {
    try {
      prune(db);
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'housekeeping');
    }
  };
  return schedule(run, 60_000, DAY);
}
