import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
import { applyClientHost } from '../src/lib/mtproxyl-host.js';

/** Сервер с MTProxyL (или без) и одной привязкой, которая уже синхронизирована. */
function setup(withMt: boolean, clientHost: string | null) {
  const db = createDb(':memory:');
  const inventory = { services: withMt ? [{ kind: 'mtproxyl' }] : [] };
  db.insert(servers)
    .values({
      id: 's1',
      name: 'NetCore',
      host: '203.0.113.10',
      clientHost,
      statusCache: { inventory },
    } as never)
    .run();
  db.insert(gclients)
    .values({ id: 'c1', name: 'anna', slug: 'anna', token: 't' } as never)
    .run();
  db.insert(gclientBindings)
    .values({
      id: 'b1',
      clientId: 'c1',
      serverId: 's1',
      service: 'xui',
      state: 'ok',
      updatedAt: '2020',
    } as never)
    .run();
  const calls: { op: string; env: Record<string, string> }[] = [];
  let finished: number | null = null;
  let kicks = 0;
  const deps = {
    db,
    registry: {
      isOnline: () => true,
      request: async (_id: string, op: string, p: { env: Record<string, string> }) => {
        calls.push({ op, env: p.env });
        return { exitCode: 0 };
      },
    },
    journal: {
      background: (
        _s: string,
        _k: string,
        _p: unknown,
        fn: (a: unknown) => Promise<void>,
        opts: { after?: (ok: boolean) => void } = {},
      ) => {
        void fn({ id: 'a1', output: '', stream: () => {} }).then(
          () => {
            finished = 0;
            opts.after?.(true);
          },
          () => {
            finished = 1;
            opts.after?.(false);
          },
        );
        return 'a1';
      },
    },
    gc: {
      kick: () => {
        kicks++;
      },
    },
  };
  return { db, deps: deps as never, calls, kicks: () => kicks, finished: () => finished };
}

describe('адрес в ссылках MTProxyL за адресом для клиентов', () => {
  it('MTProxyL есть: сначала адрес в ссылках, затем синхронизация сервера', async () => {
    const t = setup(true, 'netcore.example.com');
    expect(applyClientHost(t.deps, 's1')).toBe('a1');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls).toEqual([{ op: 'command.run', env: { MT_HOST: 'netcore.example.com' } }]);
    expect(t.finished()).toBe(0);
    expect(t.kicks()).toBe(1);
    expect(t.db.select().from(gclientBindings).get()?.state).toBe('pending');
  });

  it('имя убрано - в ссылках снова IP (пустой CUSTOM_IP)', async () => {
    const t = setup(true, null);
    applyClientHost(t.deps, 's1');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.calls[0]?.env).toEqual({ MT_HOST: '' });
  });

  it('MTProxyL нет - сразу синхронизация, без действия', () => {
    const t = setup(false, 'netcore.example.com');
    expect(applyClientHost(t.deps, 's1')).toBeNull();
    expect(t.calls).toEqual([]);
    expect(t.kicks()).toBe(1);
    expect(t.db.select().from(gclientBindings).get()?.state).toBe('pending');
  });
});
