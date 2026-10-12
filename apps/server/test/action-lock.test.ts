import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import { beginAction } from '../src/lib/action-lock.js';

let dir: string;
let db: Db;
const start = (id: string, kind: string, serverId = 's1', force = false) =>
  beginAction(db, { id, serverId, kind, params: {} }, force);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lock-'));
  db = createDb(dir);
  for (const id of ['s1', 's2'])
    db.insert(servers)
      .values({ id, name: id, host: `${id}.example`, agentTokenHash: 'x' } as never)
      .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('beginAction', () => {
  it('второе действие на занятом сервере - 409 с названием первого', () => {
    start('a1', 'xui:update');
    expect(() => start('a2', 'docker.stop')).toThrow(/уже выполняется: 3X-UI: обновление/);
    let err: unknown;
    try {
      start('a3', 'command:xui');
    } catch (e) {
      err = e;
    }
    expect((err as { statusCode?: number } | undefined)?.statusCode).toBe(409);
  });
  it('у команды каталога в сообщении её заголовок', () => {
    beginAction(db, { id: 'c1', serverId: 's1', kind: 'command:xui', params: { title: '3X-UI' } });
    expect(() => start('a1', 'cleanup')).toThrow('уже выполняется: команда \u00ab3X-UI\u00bb');
  });
  it('после завершения и на другом сервере - можно', () => {
    start('a1', 'system.upgrade');
    expect(() => start('b1', 'system.upgrade', 's2')).not.toThrow();
    db.update(actionLog)
      .set({ finishedAt: new Date().toISOString() })
      .where(eq(actionLog.id, 'a1'))
      .run();
    expect(() => start('a2', 'cleanup')).not.toThrow();
  });
  it('терминал и чтения сервер не занимают и не ждут', () => {
    start('t1', 'terminal');
    expect(() => start('a1', 'backup.create')).not.toThrow();
    expect(() => start('r1', 'mtproxyl:secret.link')).not.toThrow();
  });
  it('переустановка агента проходит принудительно, зависшее действие не держит', () => {
    start('a1', 'agent.update');
    expect(() => start('i1', 'agent.install', 's1', true)).not.toThrow();
    // дольше самой длинной команды каталога (4 часа) с запасом
    const old = new Date(Date.now() - 5 * 60 * 60_000).toISOString();
    db.update(actionLog).set({ startedAt: old }).where(eq(actionLog.serverId, 's1')).run();
    expect(() => start('a2', 'cleanup')).not.toThrow();
  });
});
