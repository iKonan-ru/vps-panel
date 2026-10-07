import type { ClientStatsSnapshot } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import {
  ClientStatsHub,
  type LiveRef,
  type Sample,
  liveBinding,
  liveOnServer,
  rates,
} from '../src/lib/client-stats.js';

const T0 = 1_759_830_000_000;
const snap = (at: number, part: Partial<ClientStatsSnapshot> = {}): ClientStatsSnapshot => ({
  at,
  errors: {},
  ...part,
});
const xuiRef: LiveRef = { id: 'b1', service: 'xui', ref: 'ivan-a1b2', key: 'ivan-a1b2' };
const awgRef: LiveRef = { id: 'b2', service: 'awg', ref: '3|amnezia-awg2|KEY=', key: '' };
const mtRef: LiveRef = { id: 'b3', service: 'mtproxyl', ref: 'ivan-a1b2', key: 'ivan-a1b2' };

describe('скорость по снимкам', () => {
  it('3X-UI: окно 10 с, а не соседний снимок (счётчики 3X-UI шагают раз в 5 с)', () => {
    const xui = (up: number, down: number) => ({
      xui: { 'ivan-a1b2': { up, down, lastOnline: T0, online: true } },
    });
    const samples: Sample[] = [0, 3, 6, 9, 12].map((s, i) => ({
      at: T0 + s * 1000,
      snap: snap(T0 + s * 1000, xui(i * 1000, i * 10_000)),
    }));
    // последний - 12 с, база - снимок 0 с (12 - 0 >= 10): 4000 байт за 12 с
    const r = rates(samples, xuiRef);
    expect(r.in).toBeCloseTo(4000 / 12);
    expect(r.out).toBeCloseTo(40_000 / 12);
  });

  it('один снимок или слишком близкие - скорости нет', () => {
    const one: Sample[] = [{ at: T0, snap: snap(T0, { mtproxyl: {} }) }];
    expect(rates(one, mtRef)).toEqual({ in: null, out: null });
    const near: Sample[] = [...one, { at: T0 + 500, snap: snap(T0 + 500, { mtproxyl: {} }) }];
    expect(rates(near, mtRef)).toEqual({ in: null, out: null });
  });

  it('обнуление счётчика (перезапуск сервиса) - скорость неизвестна, не минус', () => {
    const peer = (rx: number, tx: number) => ({
      awg: { 'amnezia-awg2': { 'KEY=': { handshake: T0 / 1000, rx, tx } } },
    });
    const samples: Sample[] = [
      { at: T0, snap: snap(T0, peer(5000, 9000)) },
      { at: T0 + 6000, snap: snap(T0 + 6000, peer(100, 9600)) },
    ];
    expect(rates(samples, awgRef)).toEqual({ in: null, out: 100 });
  });

  it('MTProxy: пользователя нет в метриках - ноль, а не неизвестно', () => {
    const samples: Sample[] = [
      { at: T0, snap: snap(T0, { mtproxyl: {} }) },
      {
        at: T0 + 6000,
        snap: snap(T0 + 6000, {
          mtproxyl: { 'ivan-a1b2': { in: 600, out: 6000, conns: 2, ips: 1 } },
        }),
      },
    ];
    expect(rates(samples, mtRef)).toEqual({ in: 100, out: 1000 });
    const b = liveBinding(mtRef, samples);
    expect(b.state).toBe('online');
    expect(b.conns).toBe(2);
    expect(b.sinceStart).toBe(true);
  });
});

describe('состояние привязки', () => {
  const at = T0;
  const one = (part: Partial<ClientStatsSnapshot>): Sample[] => [{ at, snap: snap(at, part) }];

  it('3X-UI: на связи, был, ни разу; нет раздела - причина из errors', () => {
    const x = (online: boolean, lastOnline: number) => ({
      xui: { 'ivan-a1b2': { up: 1, down: 2, lastOnline, online } },
    });
    expect(liveBinding(xuiRef, one(x(true, at))).state).toBe('online');
    const idle = liveBinding(xuiRef, one(x(false, at - 60_000)));
    expect(idle.state).toBe('idle');
    expect(idle.lastSeen).toBe(new Date(at - 60_000).toISOString());
    expect(idle.totalIn).toBe(1);
    expect(idle.totalOut).toBe(2);
    expect(liveBinding(xuiRef, one(x(false, 0))).state).toBe('never');
    const down = liveBinding(xuiRef, one({ errors: { xui: 'нет API-токена 3X-UI' } }));
    expect(down).toMatchObject({ state: 'down', note: 'нет API-токена 3X-UI' });
    expect(liveBinding(xuiRef, one({ xui: {} })).state).toBe('missing');
  });

  it('AWG: handshake не старше 3 минут - на связи; контейнера нет - сервис не работает', () => {
    const p = (handshake: number) => ({
      awg: { 'amnezia-awg2': { 'KEY=': { handshake, rx: 1, tx: 2 } } },
    });
    expect(liveBinding(awgRef, one(p(at / 1000 - 60))).state).toBe('online');
    expect(liveBinding(awgRef, one(p(at / 1000 - 600))).state).toBe('idle');
    expect(liveBinding(awgRef, one(p(0))).state).toBe('never');
    expect(liveBinding(awgRef, one({ awg: {} })).state).toBe('down');
    expect(liveBinding({ ...awgRef, ref: '3||' }, one({ awg: {} })).state).toBe('missing');
  });

  it('WDTT, OpenFlux, naive', () => {
    const w: LiveRef = { id: 'b4', service: 'wdtt', ref: 'ivan', key: 'k1' };
    expect(liveBinding(w, one({ wdtt: { k1: { up: 1, down: 2, devices: 1 } } }))).toMatchObject({
      state: 'online',
      devices: 1,
      totalIn: 1,
      totalOut: 2,
    });
    const of: LiveRef = { id: 'b5', service: 'openflux', ref: 'vp-1', key: 'vp-1' };
    const ch = (active: boolean, conns: number) => ({
      openflux: { 'vp-1': { active, since: '', conns } },
    });
    expect(liveBinding(of, one(ch(true, 1))).state).toBe('online');
    expect(liveBinding(of, one(ch(true, 0))).state).toBe('running');
    expect(liveBinding(of, one(ch(false, 0))).state).toBe('down');
    const nv: LiveRef = { id: 'b6', service: 'naive', ref: 'ivan', key: 'ivan' };
    expect(liveBinding(nv, one({ naive: true })).state).toBe('running');
    expect(liveBinding(nv, one({ naive: false })).state).toBe('down');
  });

  it('сервер не в сети, агент устарел, агент не ответил', () => {
    const info = { serverId: 's1', online: true, outdated: false, at: null, error: '' };
    expect(liveOnServer(xuiRef, { info: { ...info, online: false }, samples: [] }).state).toBe(
      'offline',
    );
    expect(liveOnServer(xuiRef, { info: { ...info, outdated: true }, samples: [] }).state).toBe(
      'outdated',
    );
    expect(
      liveOnServer(xuiRef, { info: { ...info, error: 'таймаут' }, samples: [] }),
    ).toMatchObject({ state: 'down', note: 'агент не ответил: таймаут' });
  });
});

describe('снимки серверов', () => {
  function fake(opts: { online?: boolean; supports?: boolean } = {}) {
    let now = T0;
    let calls = 0;
    const tokens: unknown[] = [];
    const registry = {
      isOnline: () => opts.online ?? true,
      supports: () => opts.supports ?? true,
      request: async (_id: string, _m: string, p: Record<string, unknown>) => {
        calls++;
        tokens.push(p.xuiToken);
        await new Promise((r) => setTimeout(r, 5));
        return snap(now, { mtproxyl: {} });
      },
    };
    const hub = new ClientStatsHub({
      registry: registry as never,
      xuiToken: () => 'tok',
      now: () => now,
    });
    return {
      hub,
      calls: () => calls,
      tokens,
      tick: (ms: number) => {
        now += ms;
      },
    };
  }

  it('один запрос на всех в пределах 2,5 с; параллельные ждут один и тот же', async () => {
    const f = fake();
    const [a, b] = await Promise.all([f.hub.server('s1'), f.hub.server('s1')]);
    expect(f.calls()).toBe(1);
    expect(a.samples).toHaveLength(1);
    expect(b.info.at).toBe(new Date(T0).toISOString());
    f.tick(1000);
    await f.hub.server('s1');
    expect(f.calls()).toBe(1);
    f.tick(2000);
    const c = await f.hub.server('s1');
    expect(f.calls()).toBe(2);
    expect(c.samples).toHaveLength(2);
    expect(f.tokens).toEqual(['tok', 'tok']);
  });

  it('старые снимки выбрасываются', async () => {
    const f = fake();
    await f.hub.server('s1');
    f.tick(60_000);
    const s = await f.hub.server('s1');
    expect(s.samples).toHaveLength(1);
  });

  it('не в сети и устаревший агент - без запроса', async () => {
    const off = fake({ online: false });
    expect((await off.hub.server('s1')).info.online).toBe(false);
    const old = fake({ supports: false });
    expect((await old.hub.server('s1')).info.outdated).toBe(true);
    expect(off.calls() + old.calls()).toBe(0);
  });
});

describe('GET /api/gclients/:id/live', () => {
  it('сервер без агента - "не в сети" по каждой привязке, без кэша в браузере', async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { buildApp } = await import('../src/app.js');
    const { loadEnv } = await import('../src/config.js');
    const { createDb } = await import('../src/db/index.js');
    const { admins, gclientBindings, gclients, servers } = await import('../src/db/schema.js');
    const { createSession } = await import('../src/lib/auth.js');
    const dir = mkdtempSync(join(tmpdir(), 'vps-live-'));
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
      const cookie = `vps_session=${(await createSession(db, 'a1', '127.0.0.1', 't')).token}`;
      db.insert(servers)
        .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
        .run();
      db.insert(gclients)
        .values({ id: 'c1', name: 'Иван', slug: 'ivan', token: 't1', xuiSubId: 'x1' })
        .run();
      db.insert(gclientBindings)
        .values([
          { id: 'b1', clientId: 'c1', serverId: 's1', service: 'xui', ref: 'ivan' },
          { id: 'b2', clientId: 'c1', serverId: 's1', service: 'naive', ref: 'ivan' },
        ])
        .run();
      const res = await built.app.inject({
        method: 'GET',
        url: '/api/gclients/c1/live',
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const body = res.json() as import('@vps/protocol').GClientLive;
      expect(body.servers).toEqual([
        { serverId: 's1', online: false, outdated: false, at: null, error: '' },
      ]);
      expect(body.bindings.map((b) => `${b.bindingId}:${b.state}`).sort()).toEqual([
        'b1:offline',
        'b2:offline',
      ]);
      // ?server= - только этот сервер
      db.insert(servers)
        .values({ id: 's2', name: 's2', host: '2.2.2.2' } as never)
        .run();
      db.insert(gclientBindings)
        .values({ id: 'b3', clientId: 'c1', serverId: 's2', service: 'xui', ref: 'ivan' })
        .run();
      const all = (
        await built.app.inject({ method: 'GET', url: '/api/gclients/c1/live', headers: { cookie } })
      ).json() as import('@vps/protocol').GClientLive;
      expect(all.servers).toHaveLength(2);
      const one = (
        await built.app.inject({
          method: 'GET',
          url: '/api/gclients/c1/live?server=s2',
          headers: { cookie },
        })
      ).json() as import('@vps/protocol').GClientLive;
      expect(one.servers.map((s) => s.serverId)).toEqual(['s2']);
      expect(one.bindings.map((b) => b.bindingId)).toEqual(['b3']);
    } finally {
      await built.app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
