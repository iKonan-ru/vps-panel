import type { ConnsListSnapshot } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclientDevices, gclients, servers } from '../src/db/schema.js';
import { ConnsHub, SEEN_TTL_MS, SeenAddrs } from '../src/lib/conns-hub.js';

const T0 = 1_759_830_000_000;

function snap(addrs: ConnsListSnapshot['addrs'], awg: ConnsListSnapshot['awg'] = []) {
  return (at: number): ConnsListSnapshot => ({
    at,
    listeners: [],
    addrs,
    awg,
    truncated: false,
    errors: {},
  });
}

function setup() {
  const db = createDb(':memory:');
  for (const [id, name, host] of [
    ['kappa', 'Kappa', '198.51.100.1'],
    ['sky', 'SkyHost', '198.51.100.2'],
    ['old', 'NetCore', '198.51.100.3'],
  ] as const)
    db.insert(servers)
      .values({ id, name, host } as never)
      .run();
  db.insert(gclients)
    .values({ id: 'anna', name: 'Анна', token: 't1', slug: 's1' } as never)
    .run();
  db.insert(gclients)
    .values({ id: 'boris', name: 'Борис', token: 't2', slug: 's2' } as never)
    .run();
  db.insert(gclientDevices)
    .values({ id: 'd1', clientId: 'boris', name: 'Ноутбук' } as never)
    .run();
  db.insert(gclientBindings)
    .values({
      id: 'b1',
      clientId: 'anna',
      serverId: 'kappa',
      service: 'xui',
      ref: 'anna-k',
    } as never)
    .run();
  db.insert(gclientBindings)
    .values({
      id: 'b2',
      clientId: 'boris',
      serverId: 'kappa',
      service: 'awg',
      deviceId: 'd1',
      ref: '2|amnezia-awg2|KEY=',
    } as never)
    .run();
  const snaps: Record<string, (at: number) => ConnsListSnapshot> = {
    kappa: snap(
      [
        { ip: '203.0.113.5', conns: 4, ports: [{ port: 8443, conns: 4 }], users: ['anna-k'] },
        { ip: '203.0.113.6', conns: 1, ports: [{ port: 443, conns: 1 }], users: [] },
      ],
      [{ container: 'amnezia-awg2', key: 'KEY=', ip: '203.0.113.7', handshake: 1, rx: 1, tx: 2 }],
    ),
    sky: snap([
      { ip: '203.0.113.5', conns: 30, ports: [{ port: 443, conns: 30 }], users: [] },
      { ip: '203.0.113.7', conns: 2, ports: [{ port: 443, conns: 2 }], users: [] },
      { ip: '203.0.113.8', conns: 2, ports: [{ port: 443, conns: 2 }], users: [] },
    ]),
  };
  let now = T0;
  let calls = 0;
  const registry = {
    isOnline: (id: string) => id in snaps,
    supports: () => true,
    latestMetrics: () => undefined,
    request: async (id: string) => {
      calls++;
      const f = snaps[id];
      if (!f) throw new Error('нет');
      return f(now);
    },
  };
  const hub = new ConnsHub(
    db,
    registry as never,
    async () => [],
    () => now,
  );
  return {
    db,
    hub,
    snaps,
    tick: (ms: number) => {
      now += ms;
    },
    calls: () => calls,
  };
}

describe('журнал адресов клиентов', () => {
  it('забывает адрес через час, свежие записи первыми', () => {
    let now = T0;
    const seen = new SeenAddrs(() => now);
    seen.add('203.0.113.1', 'a', 's1', T0 - 1000);
    seen.add('203.0.113.1', 'b', 's2', T0);
    seen.add('203.0.113.1', 'a', 's1', T0 - 5000);
    expect(seen.get('203.0.113.1').map((s) => s.clientId)).toEqual(['b', 'a']);
    expect(seen.get('203.0.113.1')[1]?.at).toBe(T0 - 1000);
    now = T0 + SEEN_TTL_MS - 500;
    expect(seen.get('203.0.113.1').map((s) => s.clientId)).toEqual(['b']);
    now = T0 + SEEN_TTL_MS + 1;
    expect(seen.get('203.0.113.1')).toEqual([]);
  });
});

describe('подключения серверов', () => {
  it('неопознанный адрес получает догадку по клиенту с другого сервера', async () => {
    const { hub } = setup();
    // до снимка Kappa о клиентах ничего не известно
    const before = await hub.view('sky');
    expect(before?.addrs.find((a) => a.ip === '203.0.113.5')?.guess).toBeUndefined();

    await hub.view('kappa');
    const v = await hub.view('sky', 0);
    const by = Object.fromEntries((v?.addrs ?? []).map((a) => [a.ip, a]));
    expect(by['203.0.113.5']).toMatchObject({
      kind: 'unknown',
      guess: [{ clientId: 'anna', name: 'Анна', serverId: 'kappa', serverName: 'Kappa' }],
    });
    expect(by['203.0.113.5']?.note).toMatch(/вероятно/);
    // адрес пира AWG - тоже адрес клиента
    expect(by['203.0.113.7']?.guess?.[0]).toMatchObject({ clientId: 'boris' });
    expect(by['203.0.113.8']?.guess).toBeUndefined();
  });

  it('несколько клиентов с одним адресом - все кандидаты', async () => {
    const { hub, snaps } = setup();
    snaps.kappa = snap([{ ip: '203.0.113.5', conns: 4, ports: [], users: ['anna-k'] }]);
    await hub.view('kappa');
    hub.seen.add('203.0.113.5', 'boris', 'old', T0 - 60_000);
    const v = await hub.view('sky', 0);
    expect(v?.addrs.find((a) => a.ip === '203.0.113.5')?.guess?.map((g) => g.name)).toEqual([
      'Анна',
      'Борис',
    ]);
  });

  it('снимок один на всех смотрящих в пределах нескольких секунд', async () => {
    const { hub, tick, calls } = setup();
    await Promise.all([hub.view('kappa'), hub.view('kappa')]);
    await hub.view('kappa');
    expect(calls()).toBe(1);
    tick(5_000);
    await hub.view('kappa');
    expect(calls()).toBe(2);
  });

  it('адреса клиента на сервере и тот же адрес на других серверах', async () => {
    const { hub } = setup();
    await hub.refreshAll();
    const anna = await hub.clientConns('anna', 'kappa');
    expect(anna.addrs).toEqual([
      {
        ip: '203.0.113.5',
        conns: 4,
        ports: [{ port: 8443, label: '', conns: 4 }],
        via: ['VLESS'],
        elsewhere: [
          {
            serverId: 'sky',
            serverName: 'SkyHost',
            kind: 'unknown',
            conns: 30,
            at: new Date(T0).toISOString(),
          },
        ],
      },
    ]);
    const boris = await hub.clientConns('boris', 'kappa');
    expect(boris.addrs[0]).toMatchObject({ ip: '203.0.113.7', conns: 0, via: ['AWG: Ноутбук'] });
    expect(await hub.clientConns('anna', 'sky')).toMatchObject({ addrs: [] });
    expect(await hub.clientConns('anna', 'old')).toMatchObject({
      at: null,
      error: 'сервер не в сети',
    });
  });
});
