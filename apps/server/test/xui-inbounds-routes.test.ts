import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { actionLog, gclientBindings, gclients, servers } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { saveXuiToken } from '../src/lib/xui-token.js';
import { xuiInboundRoutes } from '../src/routes/xui-inbounds.js';

/**
 * Имитация REST 3X-UI через агента: inbound-ы в памяти; xrayAfterAdd - каким станет Xray
 * после добавления ('running' или 'error').
 */
async function setup(
  opts: { xrayAfterAdd?: string; listeners?: { port: number; process: string }[] } = {},
) {
  const db = createDb(':memory:');
  const box = new SecretBox('s'.repeat(40));
  db.insert(servers)
    .values({
      id: 's1',
      name: 'Hoster',
      host: '203.0.113.10',
      xuiExcluded: [7],
      statusCache: {
        inventory: {
          firewall: {
            listeners: (opts.listeners ?? []).map((l) => ({ proto: 'tcp', open: true, ...l })),
          },
        },
      },
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
  await saveXuiToken(db, box, 's1', 'tok');
  const inbounds: Record<string, unknown>[] = [
    {
      id: 7,
      remark: 'VLESS',
      port: 28512,
      protocol: 'vless',
      streamSettings:
        '{"security":"reality","realitySettings":{"target":"dl.google.com:443","serverNames":["google.com"],"settings":{"fingerprint":"firefox"}}}',
    },
  ];
  let xray = 'running';
  const updates: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });
  const registry = {
    isOnline: () => true,
    supports: () => false,
    refreshInventory: async () => undefined,
    request: async (
      _id: string,
      method: string,
      p: { method: string; path: string; body: unknown },
    ) => {
      if (method !== 'xui.api') throw new Error(method);
      calls.push(`${p.method} ${p.path}`);
      if (p.path === 'inbounds/list') return ok(inbounds);
      if (p.path === 'server/status')
        return ok({
          xray: { state: xray, errorMsg: xray === 'error' ? 'failed to listen TCP on 8443' : '' },
        });
      if (p.path === 'server/scanRealityTargets')
        return ok([
          {
            target: 'dl.google.com:443',
            host: 'dl.google.com',
            feasible: true,
            latencyMs: 9,
            serverNames: ['dl.google.com', 'youtube.com'],
          },
        ]);
      if (p.path === 'inbounds/add') {
        const b = p.body as Record<string, unknown>;
        inbounds.push({ ...b, id: 9 });
        xray = opts.xrayAfterAdd ?? 'running';
        return ok({ id: 9 });
      }
      if (p.path.startsWith('inbounds/update/')) {
        const id = Number(p.path.split('/')[2]);
        const b = p.body as Record<string, unknown>;
        const i = inbounds.findIndex((x) => x.id === id);
        const restoring = JSON.stringify(b) === JSON.stringify(inbounds[i]);
        inbounds[i] = { ...b };
        updates.push(b);
        xray = restoring ? 'running' : (opts.xrayAfterAdd ?? 'running');
        // возврат как было: Xray снова работает
        if (updates.length > 1) xray = 'running';
        return ok(b);
      }
      if (p.path.startsWith('inbounds/get/'))
        return ok(inbounds.find((i) => i.id === Number(p.path.split('/')[2])) ?? null);
      if (p.path.startsWith('inbounds/del/')) {
        const id = Number(p.path.split('/')[2]);
        inbounds.splice(
          inbounds.findIndex((i) => i.id === id),
          1,
        );
        xray = 'running';
        return ok(id);
      }
      return { status: 404 };
    },
  };
  let kicks = 0;
  let spareSyncs = 0;
  const dropped: number[] = [];
  const exitCalls: [string, number, boolean][] = [];
  const app = Fastify();
  await app.register(xuiInboundRoutes, {
    db,
    box,
    registry: registry as never,
    hub: { broadcast: () => {} } as never,
    env: {} as never,
    engines: {} as never,
    gc: { kick: () => void kicks++ },
    xrayChecksMs: [10, 10],
    xray: { exits: () => [] },
    exitsAfter: async (sid: string, iid: number, gone: boolean) => {
      exitCalls.push([sid, iid, gone]);
      return ['Основной выход в Telegram перенесён на запасной: NetCore'];
    },
    syncSpares: () => void spareSyncs++,
    reach: { dropInbound: (_s: string, i: number) => void dropped.push(i) },
  });
  const finished = async (kind = 'xui:inbound.add') => {
    for (let i = 0; i < 400; i++) {
      const a = db
        .select()
        .from(actionLog)
        .all()
        .find((x) => x.kind === kind);
      if (a?.finishedAt) return a;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('действие не закончилось');
  };
  return {
    app,
    db,
    inbounds,
    calls,
    kicks: () => kicks,
    spareSyncs: () => spareSyncs,
    dropped,
    exitCalls,
    updates,
    finished,
  };
}

const body = {
  items: [{ kind: 'xhttp', port: 8443, remark: 'XHTTP' }],
  target: 'dl.google.com:443',
  serverNames: ['dl.google.com', 'youtube.com'],
  fingerprint: 'firefox',
};

describe('inbound-ы VLESS из панели', () => {
  it('значения окна: свободные порты, подписи, цель стоящего inbound-а', async () => {
    const t = await setup({ listeners: [{ port: 443, process: 'caddy' }] });
    const r = await t.app.inject({ method: 'GET', url: '/api/servers/s1/xui/inbound-new' });
    const j = r.json();
    expect(j.xhttp).toMatchObject({ port: 8443, remark: 'XHTTP', note: null });
    expect(j.raw.remark).toBe('VLESS 2');
    expect(j.raw.port).toBeGreaterThanOrEqual(10000);
    expect(j.same).toEqual([
      {
        id: 7,
        remark: 'VLESS',
        target: 'dl.google.com:443',
        serverNames: ['google.com'],
        fingerprint: 'firefox',
      },
    ]);
  });

  it('8443 занят - другой порт и причина', async () => {
    const t = await setup({ listeners: [{ port: 8443, process: 'caddy' }] });
    const j = (
      await t.app.inject({ method: 'GET', url: '/api/servers/s1/xui/inbound-new' })
    ).json();
    expect(j.xhttp.port).not.toBe(8443);
    expect(j.xhttp.note).toMatch(/caddy/);
  });

  it('скан целей: без имён YouTube', async () => {
    const t = await setup();
    const j = (
      await t.app.inject({
        method: 'POST',
        url: '/api/servers/s1/xui/reality-scan',
        payload: { preset: 'foreign' },
      })
    ).json();
    expect(j.targets).toEqual([
      { target: 'dl.google.com:443', serverNames: ['dl.google.com'], latencyMs: 9, issuer: '' },
    ]);
  });

  it(
    'добавление: inbound без YouTube, Xray работает, синхронизация сразу',
    { timeout: 60_000 },
    async () => {
      const t = await setup();
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/servers/s1/xui/inbounds/new',
        payload: body,
      });
      expect(r.statusCode).toBe(200);
      const a = await t.finished();
      expect(a.exitCode).toBe(0);
      const added = t.inbounds.find((i) => i.id === 9);
      const rs = JSON.parse(String(added?.streamSettings)).realitySettings;
      expect(rs.serverNames).toEqual(['dl.google.com']);
      expect(a.output).not.toContain(rs.privateKey);
      expect(t.kicks()).toBe(1);
      expect(t.db.select().from(gclientBindings).get()?.state).toBe('pending');
      // новый RAW может стать запасным выходом в Telegram - запасные пересобираются сразу
      expect(t.spareSyncs()).toBe(1);
    },
  );

  it(
    'Xray остановился - inbound удаляется, ошибка с журналом Xray',
    { timeout: 60_000 },
    async () => {
      const t = await setup({ xrayAfterAdd: 'error' });
      await t.app.inject({
        method: 'POST',
        url: '/api/servers/s1/xui/inbounds/new',
        payload: body,
      });
      const a = await t.finished();
      expect(a.exitCode).toBe(1);
      expect(a.output).toMatch(/inbound удалён/);
      expect(a.output).toMatch(/failed to listen TCP on 8443/);
      expect(t.calls).toContain('POST inbounds/del/9');
      expect(t.inbounds.map((i) => i.id)).toEqual([7]);
      expect(t.kicks()).toBe(0);
    },
  );

  it('занятый порт - до добавления', { timeout: 60_000 }, async () => {
    const t = await setup({ listeners: [{ port: 8443, process: 'caddy' }] });
    await t.app.inject({ method: 'POST', url: '/api/servers/s1/xui/inbounds/new', payload: body });
    const a = await t.finished();
    expect(a.exitCode).toBe(1);
    expect(a.output).toMatch(/занят: caddy/);
    expect(t.calls).not.toContain('POST inbounds/add');
  });

  it('удаление: исключение, цель доступности, синхронизация', async () => {
    const t = await setup();
    const r = await t.app.inject({ method: 'POST', url: '/api/servers/s1/xui/inbounds/7/delete' });
    expect(r.statusCode).toBe(200);
    expect(t.inbounds).toHaveLength(0);
    expect(t.db.select().from(servers).get()?.xuiExcluded).toEqual([]);
    expect(t.dropped).toEqual([7]);
    expect(t.kicks()).toBe(1);
    expect(t.exitCalls).toEqual([['s1', 7, true]]);
    const a = t.db
      .select()
      .from(actionLog)
      .all()
      .find((x) => x.kind === 'xui:inbound.remove');
    expect(a?.output).toMatch(/перенесён на запасной/);
  });

  it(
    'правка: цель Reality без YouTube, ключи и shortIds как были, синхронизация и выходы',
    { timeout: 60_000 },
    async () => {
      const t = await setup();
      t.inbounds[0] = {
        ...t.inbounds[0],
        streamSettings: JSON.stringify({
          network: 'tcp',
          security: 'reality',
          realitySettings: {
            target: 'dl.google.com:443',
            serverNames: ['google.com'],
            privateKey: 'PRIV',
            shortIds: ['ab'],
            settings: { publicKey: 'PUB', fingerprint: 'firefox' },
          },
        }),
      };
      const ed = (
        await t.app.inject({ method: 'GET', url: '/api/servers/s1/xui/inbounds/7/edit' })
      ).json();
      expect(ed).toMatchObject({
        kind: 'raw',
        port: 28512,
        reality: { target: 'dl.google.com:443', fingerprint: 'firefox' },
      });
      const r = await t.app.inject({
        method: 'POST',
        url: '/api/servers/s1/xui/inbounds/7/edit',
        payload: {
          port: 30001,
          target: 'www.microsoft.com:443',
          serverNames: ['www.microsoft.com', 'youtube.com'],
          fingerprint: 'chrome',
        },
      });
      expect(r.statusCode).toBe(200);
      const a = await t.finished('xui:inbound');
      expect(a.exitCode).toBe(0);
      const st = JSON.parse(String(t.inbounds[0]?.streamSettings));
      expect(t.inbounds[0]?.port).toBe(30001);
      expect(st.realitySettings).toMatchObject({
        target: 'www.microsoft.com:443',
        serverNames: ['www.microsoft.com'],
        privateKey: 'PRIV',
        shortIds: ['ab'],
        settings: { publicKey: 'PUB', fingerprint: 'chrome' },
      });
      expect(t.kicks()).toBe(1);
      expect(t.exitCalls).toEqual([['s1', 7, false]]);
    },
  );

  it('правка: Xray остановился - inbound возвращается как был', { timeout: 60_000 }, async () => {
    const t = await setup({ xrayAfterAdd: 'error' });
    await t.app.inject({
      method: 'POST',
      url: '/api/servers/s1/xui/inbounds/7/edit',
      payload: { port: 30002 },
    });
    const a = await t.finished('xui:inbound');
    expect(a.exitCode).toBe(1);
    expect(a.output).toMatch(/возвращён как был/);
    expect(t.inbounds[0]?.port).toBe(28512);
    expect(t.kicks()).toBe(0);
  });

  it(
    'правка: занятый порт - отказ до изменения; только подпись - без проверки Xray',
    { timeout: 60_000 },
    async () => {
      const t = await setup({ listeners: [{ port: 443, process: 'caddy' }] });
      await t.app.inject({
        method: 'POST',
        url: '/api/servers/s1/xui/inbounds/7/edit',
        payload: { port: 443 },
      });
      const a = await t.finished('xui:inbound');
      expect(a.exitCode).toBe(1);
      expect(a.output).toMatch(/занят: caddy/);
      expect(t.updates).toHaveLength(0);
    },
  );

  it('случайный свободный порт: не занятый и не из уже выбранных', async () => {
    const t = await setup({ listeners: [{ port: 443, process: 'caddy' }] });
    const j = (
      await t.app.inject({ method: 'GET', url: '/api/servers/s1/xui/free-port?not=8443' })
    ).json();
    expect(j.port).toBeGreaterThanOrEqual(10000);
    expect([8443, 28512, 443]).not.toContain(j.port);
  });
});
