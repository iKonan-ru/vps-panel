import type { ClientStatsSnapshot, GLiveBinding } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import {
  type WatchState,
  clientWatches,
  gclientBindings,
  gclientDevices,
  gclients,
  servers,
} from '../src/db/schema.js';
import { ClientStatsHub } from '../src/lib/client-stats.js';
import {
  ClientWatch,
  type Observation,
  WATCH_SETTLE_MS,
  matches,
  observe,
  watchStep,
} from '../src/lib/client-watch.js';
import { tgSpan } from '../src/lib/telegram.js';

const T0 = Date.parse('2026-10-23T10:00:00Z');
const MIN = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const live = (state: GLiveBinding['state'], lastSeen: string | null = null, note = '') =>
  ({ bindingId: 'b', state, lastSeen, note }) as GLiveBinding;
const rule = { delayMinutes: 5, event: 'both' as const };
const up: Observation = { status: 'up', lastSeen: null, note: '' };
const down = (lastSeen: number | null): Observation => ({
  status: 'down',
  lastSeen: lastSeen === null ? null : iso(lastSeen),
  note: '',
});
const unknown: Observation = { status: 'unknown', lastSeen: null, note: 'сервер не в сети' };

/** Прогон наблюдений по минутам с T0; возвращает сообщения с минутой. */
function run(
  obs: Observation[],
  r: { delayMinutes: number; event: 'down' | 'up' | 'both' } = rule,
) {
  let st: WatchState | null = null;
  const sent: { at: number; kind: string; forMs: number }[] = [];
  obs.forEach((o, i) => {
    const s = watchStep(st, o, r, T0 + i * MIN);
    st = s.state;
    if (s.send) sent.push({ at: i, kind: s.send.kind, forMs: s.send.forMs });
  });
  return { sent, state: st as WatchState | null };
}

describe('связь по привязкам', () => {
  it('на связи хотя бы одна - up; иначе точно не на связи - down; иначе unknown', () => {
    expect(observe([]).status).toBe('unknown');
    expect(
      observe([
        { service: 'awg', live: live('offline', null, 'сервер не в сети') },
        { service: 'xui', live: live('online') },
      ]).status,
    ).toBe('up');
    const o = observe([
      { service: 'awg', live: live('offline', null, 'сервер не в сети') },
      { service: 'awg', live: live('idle', iso(T0)) },
      { service: 'xui', live: live('idle', iso(T0 + MIN)) },
    ]);
    expect(o).toEqual({ status: 'down', lastSeen: iso(T0 + MIN), note: '' });
    expect(observe([{ service: 'awg', live: live('down', null, 'AWG не отвечает') }])).toEqual({
      status: 'unknown',
      lastSeen: null,
      note: 'AWG не отвечает',
    });
  });

  it('OpenFlux без видимого подключения не в счёт, браузер без отчёта расширения - не на связи', () => {
    expect(observe([{ service: 'openflux', live: live('running') }]).status).toBe('unknown');
    expect(observe([{ service: 'naive', live: live('running') }]).status).toBe('down');
  });

  it('правило: не заданные сервер, сервис и устройство - любые', () => {
    const b = { serverId: 's1', service: 'awg', deviceId: 'd1' };
    expect(matches({ serverId: null, service: null, deviceId: null }, b)).toBe(true);
    expect(matches({ serverId: 's1', service: 'awg', deviceId: 'd1' }, b)).toBe(true);
    expect(matches({ serverId: 's2', service: null, deviceId: null }, b)).toBe(false);
    expect(matches({ serverId: null, service: null, deviceId: 'd2' }, b)).toBe(false);
    // устройство задано - только записи на устройство (VLESS - на человека)
    expect(
      matches(
        { serverId: null, service: null, deviceId: 'd1' },
        { ...b, service: 'xui', deviceId: null },
      ),
    ).toBe(false);
  });
});

describe('шаг наблюдения', () => {
  it('первая проверка - без сообщений, даже если клиент давно не на связи', () => {
    const { sent, state } = run([down(T0 - 60 * MIN), down(T0 - 60 * MIN)]);
    expect(sent).toEqual([]);
    expect(state?.offline).toBe(true);
  });

  it('пропал: сообщение через задержку от последней активности, один раз; вернулся - с длительностью', () => {
    // на связи 3 минуты, последняя активность - на минуте 2, дальше тишина
    const obs = [up, up, up, ...Array.from({ length: 10 }, () => down(T0 + 2 * MIN)), up];
    const { sent } = run(obs);
    expect(sent).toEqual([
      { at: 7, kind: 'down', forMs: 5 * MIN },
      { at: 13, kind: 'up', forMs: 11 * MIN },
    ]);
  });

  it('неизвестность (сервер не в сети) ничего не шлёт; после неё - время переподключиться', () => {
    const obs = [
      up,
      up,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      down(T0 + MIN),
    ];
    const r1 = run(obs);
    expect(r1.sent).toEqual([]);
    // клиент так и не подключился: сообщение через WATCH_SETTLE_MS после возврата сервера
    const settle = WATCH_SETTLE_MS / MIN;
    const tail = Array.from({ length: settle + 1 }, () => down(T0 + MIN));
    const r2 = run([...obs, ...tail]);
    expect(r2.sent).toEqual([{ at: 9 + settle, kind: 'down', forMs: (8 + settle) * MIN }]);
  });

  it('последняя активность неизвестна (MTProxy, WDTT) - отсчёт от первой проверки "не на связи"', () => {
    const { sent } = run([
      up,
      down(null),
      down(null),
      down(null),
      down(null),
      down(null),
      down(null),
    ]);
    // по наблюдению панели последний раз на связи - минута 0
    expect(sent).toEqual([{ at: 5, kind: 'down', forMs: 5 * MIN }]);
  });

  it('событие "подключение": о пропаже молчит, о возврате сообщает', () => {
    const obs = [up, ...Array.from({ length: 7 }, () => down(T0)), up];
    expect(run(obs, { delayMinutes: 5, event: 'up' }).sent.map((s) => s.kind)).toEqual(['up']);
    expect(run(obs, { delayMinutes: 5, event: 'down' }).sent.map((s) => s.kind)).toEqual(['down']);
  });

  it('короткий обрыв меньше задержки - без сообщений', () => {
    const obs = [up, down(T0), down(T0), up, up];
    expect(run(obs).sent).toEqual([]);
  });
});

describe('наблюдатель', () => {
  function setup(snaps: (() => ClientStatsSnapshot)[]) {
    const db = createDb(':memory:');
    db.insert(servers).values({ id: 's1', name: 'Hoster', host: '203.0.113.5' }).run();
    db.insert(gclients).values({ id: 'c1', name: 'Иванов', token: 't1', slug: 'ivanov' }).run();
    db.insert(gclientDevices)
      .values({ id: 'd1', clientId: 'c1', name: 'дача', type: 'router' })
      .run();
    db.insert(gclientBindings)
      .values({
        id: 'b1',
        clientId: 'c1',
        deviceId: 'd1',
        serverId: 's1',
        service: 'awg',
        ref: '3|amnezia-awg2|KEY=',
        state: 'ok',
      })
      .run();
    db.insert(clientWatches)
      .values({
        id: 'w1',
        clientId: 'c1',
        serverId: 's1',
        service: 'awg',
        deviceId: 'd1',
        delayMinutes: 5,
      })
      .run();
    let now = T0;
    let i = 0;
    const hub = new ClientStatsHub({
      registry: {
        isOnline: () => true,
        supports: () => true,
        request: async <T>() =>
          (snaps[Math.min(i++, snaps.length - 1)] as () => ClientStatsSnapshot)() as T,
      },
      xuiToken: () => '',
      now: () => now,
    });
    const sent: string[] = [];
    const watch = new ClientWatch({
      db,
      box: { open: (s: string) => s } as never,
      hub,
      telegram: {
        send: async (t) => {
          sent.push(t);
          return null;
        },
      },
      panelUrl: 'https://panel.example.com',
      log: { warn: () => undefined },
      now: () => now,
    });
    return {
      db,
      watch,
      sent,
      tick: async () => {
        await watch.tick();
        now += MIN;
      },
      at: () => now,
    };
  }

  it('AWG роутера: handshake устарел - "нет связи", обновился - "снова на связи"', async () => {
    let hs = T0 / 1000;
    let clock = T0;
    const snap = (): ClientStatsSnapshot => ({
      at: clock,
      errors: {},
      awg: { 'amnezia-awg2': { 'KEY=': { handshake: hs, rx: 1, tx: 1 } } },
    });
    const t = setup([snap]);
    // минуты 0-1 на связи (handshake обновляется), потом роутер пропал
    for (let m = 0; m < 12; m++) {
      clock = t.at();
      if (m < 2) hs = clock / 1000;
      await t.tick();
    }
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toContain(
      '<a href="https://panel.example.com/clients/c1"><b>Иванов</b></a>, роутер: дача',
    );
    expect(t.sent[0]).toContain(`нет связи ${tgSpan(5 * MIN)} (AWG, Hoster)`);
    clock = t.at();
    hs = clock / 1000;
    await t.tick();
    expect(t.sent[1]).toContain('снова на связи (AWG, Hoster), не было');
    const st = t.db.select().from(clientWatches).get()?.state;
    expect(st?.status).toBe('up');
    expect(st?.offline).toBe(false);
  });

  it('выключенный клиент - состояние неизвестно, без сообщений', async () => {
    const t = setup([() => ({ at: T0, errors: {} })]);
    t.db.update(gclients).set({ enabled: false }).run();
    await t.tick();
    const st = t.db.select().from(clientWatches).get()?.state;
    expect(st?.status).toBe('unknown');
    expect(st?.note).toBe('клиент выключен');
    expect(t.sent).toEqual([]);
  });
});

describe('маршруты /api/watch', () => {
  it('создание, список с вариантами, проверки, правка сбрасывает наблюдение, удаление', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { buildApp } = await import('../src/app.js');
    const { loadEnv } = await import('../src/config.js');
    const { admins } = await import('../src/db/schema.js');
    const { createSession } = await import('../src/lib/auth.js');
    const dir = mkdtempSync(join(tmpdir(), 'vps-watch-'));
    const built = await buildApp({
      env: loadEnv({ NODE_ENV: 'test', DATA_DIR: dir }),
      db: createDb(':memory:'),
    });
    try {
      await built.app.ready();
      const { db } = built;
      db.insert(admins)
        .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
        .run();
      const token = (await createSession(db, 'a1', '127.0.0.1', 't')).token;
      const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
        built.app.inject({
          method,
          url,
          cookies: { vps_session: token },
          ...(payload ? { payload } : {}),
        });
      db.insert(servers).values({ id: 's1', name: 'Hoster', host: '203.0.113.5' }).run();
      db.insert(gclients)
        .values([
          { id: 'c1', name: 'Иванов', token: 't1', slug: 'ivanov' },
          { id: 'c2', name: 'Петров', token: 't2', slug: 'petrov' },
        ])
        .run();
      db.insert(gclientDevices)
        .values([
          { id: 'd1', clientId: 'c1', name: 'дача', type: 'router' },
          { id: 'd2', clientId: 'c2', name: '', type: 'ios' },
        ])
        .run();
      db.insert(gclientBindings)
        .values([
          { id: 'b1', clientId: 'c1', deviceId: 'd1', serverId: 's1', service: 'awg', ref: 'x' },
          { id: 'b2', clientId: 'c1', serverId: 's1', service: 'openflux', ref: 'y' },
        ])
        .run();
      const body = {
        clientId: 'c1',
        serverId: 's1',
        service: 'awg',
        deviceId: 'd1',
        event: 'both',
        delayMinutes: 10,
        enabled: true,
      };
      expect((await call('POST', '/api/watch', { ...body, service: 'openflux' })).statusCode).toBe(
        400,
      );
      expect((await call('POST', '/api/watch', { ...body, deviceId: 'd2' })).statusCode).toBe(400);
      expect((await call('POST', '/api/watch', { ...body, delayMinutes: 0 })).statusCode).toBe(400);
      const created = await call('POST', '/api/watch', body);
      expect(created.statusCode).toBe(200);
      const id = created.json().id as string;

      const list = (await call('GET', '/api/watch')).json();
      expect(list.rules).toHaveLength(1);
      expect(list.rules[0]).toMatchObject({
        clientName: 'Иванов',
        serverName: 'Hoster',
        deviceName: 'роутер: дача',
        delayMinutes: 10,
      });
      const ivanov = list.clients.find((c: { id: string }) => c.id === 'c1');
      // OpenFlux в вариантах нет: его подключения видны не все
      expect(ivanov.targets).toEqual([
        { serverId: 's1', serverName: 'Hoster', service: 'awg', deviceId: 'd1' },
      ]);

      const st: WatchState = {
        primed: true,
        status: 'down',
        offline: true,
        lastSeen: null,
        downSince: null,
        checkedAt: iso(T0),
        note: '',
      };
      db.update(clientWatches).set({ state: st }).run();
      // только событие - наблюдение остаётся
      await call('PUT', `/api/watch/${id}`, { ...body, event: 'down' });
      expect(db.select().from(clientWatches).get()?.state?.offline).toBe(true);
      // выключение - наблюдение заново, в списке "выключено"
      await call('PUT', `/api/watch/${id}`, { ...body, event: 'down', enabled: false });
      expect(db.select().from(clientWatches).get()?.state).toBeNull();
      expect((await call('GET', '/api/watch')).json().rules[0].status).toBe('off');

      expect((await call('DELETE', `/api/watch/${id}`)).statusCode).toBe(200);
      expect((await call('GET', '/api/watch')).json().rules).toEqual([]);
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
