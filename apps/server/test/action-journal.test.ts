import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import { MAX_OUTPUT, actionJournal, onActionFinished } from '../src/lib/action-journal.js';
import { UiHub } from '../src/lib/ui-hub.js';

function setup() {
  const db = createDb(':memory:');
  db.insert(servers)
    .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
    .run();
  return { db, journal: actionJournal(db, new UiHub(), new AgentRegistry()) };
}

describe('actionJournal.open', () => {
  it('streams, keeps only a tail in memory and writes the result', async () => {
    const { db, journal } = setup();
    const a = journal.open('s1', 'test.run', { x: 1 });
    for (let i = 0; i < 25; i++) a.stream('stdout', 'x'.repeat(100_000));
    a.stream('stdout', 'END');
    expect(a.output.length).toBeLessThanOrEqual(2 * MAX_OUTPUT);
    expect(a.output.endsWith('END')).toBe(true);
    await a.finish(0);
    const row = db.select().from(actionLog).where(eq(actionLog.id, a.id)).get();
    expect(row?.exitCode).toBe(0);
    expect(row?.output.length).toBe(MAX_OUTPUT);
    expect(row?.output.endsWith('END')).toBe(true);
  });

  it('holds the server lock, force bypasses it, text replaces secret output', async () => {
    const { db, journal } = setup();
    const a = journal.open('s1', 'command:x');
    expect(() => journal.open('s1', 'command:y')).toThrow(/уже выполняется/);
    const b = journal.open('s1', 'agent.install', {}, true);
    a.stream('stdout', 'tg://proxy?secret=ee00');
    await a.finish(0, 'вывод не сохраняется');
    await b.finish(1);
    expect(db.select().from(actionLog).where(eq(actionLog.id, a.id)).get()?.output).toBe(
      'вывод не сохраняется',
    );
    expect(() => journal.open('s1', 'command:z')).not.toThrow();
  });
});

describe('окончание действия', () => {
  it('подписчики узнают сервер, вид действия и запрошенный свежий снимок', async () => {
    const { journal } = setup();
    const seen: [string, string][] = [];
    let fresh: Promise<void> | null = null;
    const stop = onActionFinished((id, kind, f) => {
      seen.push([id, kind]);
      fresh = f;
    });
    const a = journal.open('s1', 'mtproxyl:update');
    await a.finish(0);
    await journal.quick('s1', 'xui:token', {}, async () => 1);
    stop();
    expect(seen).toEqual([
      ['s1', 'mtproxyl:update'],
      ['s1', 'xui:token'],
    ]);
    await expect(fresh).resolves.toBeUndefined();
  });
});
