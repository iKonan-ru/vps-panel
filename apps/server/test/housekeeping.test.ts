import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { actionLog, admins, loginAttempts, sessions } from '../src/db/schema.js';
import { prune } from '../src/lib/housekeeping.js';

describe('prune', () => {
  it('keeps recent and running actions, drops old sync passes, attempts and expired sessions', () => {
    const db = createDb(':memory:');
    const now = Date.parse('2026-10-03T12:00:00Z');
    const ago = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const act = (id: string, kind: string, days: number, finished = true) =>
      db
        .insert(actionLog)
        .values({ id, kind, startedAt: ago(days), finishedAt: finished ? ago(days) : null })
        .run();
    act('sync-new', 'gclients.sync', 3);
    act('sync-old', 'gclients.sync', 20);
    act('cmd-mid', 'command:xui', 100);
    act('cmd-old', 'command:xui', 200);
    act('cmd-running', 'command:xui', 200, false);
    db.insert(admins)
      .values({ id: 'a', login: 'a', passwordHash: 'x', totpSecret: 's', backupCodesHash: [] })
      .run();
    db.insert(sessions)
      .values({ id: 'live', adminId: 'a', expiresAt: ago(-1), ip: '', userAgent: '' })
      .run();
    db.insert(sessions)
      .values({ id: 'dead', adminId: 'a', expiresAt: ago(1), ip: '', userAgent: '' })
      .run();
    db.insert(loginAttempts)
      .values({ ip: '1', login: 'a', ok: false, at: ago(40) })
      .run();
    db.insert(loginAttempts)
      .values({ ip: '2', login: 'a', ok: false, at: ago(1) })
      .run();

    prune(db, now);

    expect(
      db
        .select({ id: actionLog.id })
        .from(actionLog)
        .all()
        .map((r) => r.id)
        .sort(),
    ).toEqual(['cmd-mid', 'cmd-running', 'sync-new']);
    expect(
      db
        .select()
        .from(sessions)
        .all()
        .map((r) => r.id),
    ).toEqual(['live']);
    expect(
      db
        .select()
        .from(loginAttempts)
        .all()
        .map((r) => r.ip),
    ).toEqual(['2']);
  });
});
