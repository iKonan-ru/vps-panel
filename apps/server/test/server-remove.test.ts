import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { Notifier } from '../src/lib/notify.js';
import { onServerRemoved, removeServer } from '../src/lib/server-remove.js';

function setup() {
  const db = createDb(':memory:');
  db.insert(servers).values({ id: 's1', name: 'Hoster', host: '203.0.113.5' }).run();
  const registry = Object.assign(new EventEmitter(), {
    isOnline: () => false,
    isUpdating: () => false,
    get: () => undefined,
  });
  const sent: string[] = [];
  let muted = ['s1', 's2'];
  const tg = {
    settings: async () => ({ offlineMinutes: 1, mutedServers: muted, events: {} }),
    save: async (p: { mutedServers?: string[] }) => {
      if (p.mutedServers) muted = p.mutedServers;
    },
    wants: async () => true,
    send: async (m: string) => {
      sent.push(m);
      return null;
    },
  };
  const n = new Notifier(db, registry as never, tg as never);
  n.bind([]);
  const env = { DATA_DIR: '/nonexistent' } as never;
  const hub = { broadcast: () => undefined } as never;
  return { db, registry, n, sent, env, hub, muted: () => muted };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('удаление сервера', () => {
  it('после удаления "не в сети" не приходит', async () => {
    vi.useFakeTimers();
    const t = setup();
    const stop = onServerRemoved((id) => void t.n.forget(id));
    t.registry.emit('offline', 's1');
    await vi.advanceTimersByTimeAsync(0);
    expect(
      removeServer({ db: t.db, env: t.env, registry: t.registry as never, hub: t.hub }, 's1'),
    ).toBe(true);
    t.registry.emit('offline', 's1');
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(t.sent).toEqual([]);
    expect(t.muted()).toEqual(['s2']);
    stop();
  });

  it('сервер в панели - "не в сети" приходит', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.registry.emit('offline', 's1');
    await vi.advanceTimersByTimeAsync(61_000);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/Hoster.*не в сети 1/);
  });

  it('подписчики узнают об удалении один раз, несуществующий сервер - false', () => {
    const t = setup();
    const seen: string[] = [];
    const stop = onServerRemoved((id) => seen.push(id));
    const deps = { db: t.db, env: t.env, registry: t.registry as never, hub: t.hub };
    expect(removeServer(deps, 's1')).toBe(true);
    expect(removeServer(deps, 's1')).toBe(false);
    expect(seen).toEqual(['s1']);
    stop();
  });
});
