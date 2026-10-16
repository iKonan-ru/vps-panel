import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import type { GClients } from '../src/lib/gclients.js';
import type { RuReach } from '../src/lib/ru-reach.js';
import type { UiHub } from '../src/lib/ui-hub.js';
import type { XrayManager } from '../src/lib/xray.js';
import { ipChangeRoutes } from '../src/routes/ip-change.js';

async function setup(addr: string) {
  const db = createDb(':memory:');
  db.insert(servers)
    .values({ id: 's', name: 's', host: '203.0.113.1', sshPort: 1 } as never)
    .run();
  const journal = {
    quick: vi.fn(
      async (
        _s: string,
        _k: string,
        _p: unknown,
        fn: () => Promise<unknown>,
        log?: (r: unknown) => string,
      ) => {
        const r = await fn();
        log?.(r);
        return r;
      },
    ),
  };
  const retarget = vi.fn(async () => true);
  const app = Fastify();
  await app.register(ipChangeRoutes, {
    db,
    registry: { get: () => ({ addr }) } as unknown as AgentRegistry,
    hub: { broadcast: () => {} } as unknown as UiHub,
    gc: { kick: () => {} } as unknown as GClients,
    xray: { retarget } as unknown as XrayManager,
    reach: { check: async () => ({}) } as unknown as RuReach,
    journal: journal as never,
  });
  return { app, db, journal, retarget };
}

describe('смена IP сервера', () => {
  it('без имени: агент с нового адреса - можно переключить, с предупреждением про конфиги', async () => {
    const { app, db, journal, retarget } = await setup('::ffff:127.0.0.1');
    const r = await app.inject({
      method: 'POST',
      url: '/api/servers/s/ip-change/check',
      payload: { ip: '127.0.0.1' },
    });
    const body = r.json() as { steps: { name: string; level: string }[]; canSwitch: boolean };
    expect(body.canSwitch).toBe(true);
    expect(body.steps.find((s) => s.name === 'Адрес для клиентов')?.level).toBe('warn');
    expect(body.steps.find((s) => s.name === 'Агент')?.level).toBe('ok');

    const sw = await app.inject({
      method: 'POST',
      url: '/api/servers/s/ip-change',
      payload: { ip: '127.0.0.1' },
    });
    expect(sw.statusCode).toBe(200);
    expect(db.select().from(servers).get()?.host).toBe('127.0.0.1');
    expect(retarget).toHaveBeenCalledWith('s', '127.0.0.1');
    expect(journal.quick.mock.calls[0]?.slice(0, 3)).toEqual([
      's',
      'server:ip',
      { from: '203.0.113.1', to: '127.0.0.1' },
    ]);
  });

  it('не IP, тот же адрес, агент со старого и SSH молчит - не переключается', async () => {
    const { app, db } = await setup('203.0.113.1');
    for (const ip of ['srv.example.com', '203.0.113.1']) {
      const r = await app.inject({
        method: 'POST',
        url: '/api/servers/s/ip-change/check',
        payload: { ip },
      });
      expect(r.json().canSwitch).toBe(false);
    }
    const sw = await app.inject({
      method: 'POST',
      url: '/api/servers/s/ip-change',
      payload: { ip: '127.0.0.2' },
    });
    expect(sw.statusCode).toBe(409);
    expect(db.select().from(servers).get()?.host).toBe('203.0.113.1');
  });
});
