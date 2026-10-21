import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { actionLog, cascades, gclientBindings, gclients, servers } from '../src/db/schema.js';
import { actionJournal } from '../src/lib/action-journal.js';
import { Cascades, cascadeClientEmail } from '../src/lib/cascades.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { buildSubscription } from '../src/lib/subscription.js';
import { saveXuiToken } from '../src/lib/xui-token.js';

const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });

/** Имитация 3X-UI одного сервера: inbound-ы, клиенты, шаблон Xray. */
function fakeXui(opts: { inbounds?: Record<string, unknown>[] } = {}) {
  const inbounds: Record<string, unknown>[] = opts.inbounds ?? [];
  const clients = new Map<string, { uuid: string; flow: string; inboundIds: number[] }>();
  let template: Record<string, unknown> = {
    outbounds: [{ tag: 'direct', protocol: 'freedom' }],
    routing: {
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', domain: ['geosite:openai'], outboundTag: 'direct' },
      ],
    },
  };
  const s = {
    inbounds,
    clients,
    get template() {
      return template;
    },
    xray: 'running',
    /** Шаблон, после записи которого Xray падает (проверка отката). */
    breakOnWrite: false,
    /** После любой записи шаблона Xray падает. */
    breakAll: false,
    /** После правки inbound-а Xray падает; возврат как было - снова работает. */
    breakOnInboundUpdate: false,
    /** 3X-UI выхода не отвечает (временный сбой). */
    exitDown: false,
    writes: 0,
    /** inbound до первой правки (для проверки возврата). */
    original: new Map<number, unknown>(),
    testUrl: 'https://example.com/204',
    /** Outbound-ы, проверка которых не проходит (выход лёг). */
    deadOutbounds: new Set<string>(),
    handle(method: string, path: string, body: unknown, form?: Record<string, string>) {
      if (path === 'inbounds/list') return ok(inbounds);
      if (path.startsWith('inbounds/get/')) {
        if (s.exitDown) return { status: 502, data: { success: false, msg: 'timeout' } };
        const got = inbounds.find((i) => i.id === Number(path.split('/')[2]));
        return got ? ok(got) : { status: 200, data: { success: false, msg: 'record not found' } };
      }
      if (path === 'inbounds/add') {
        const b = body as Record<string, unknown>;
        const id = 100 + inbounds.length;
        inbounds.push({ ...b, id, tag: `in-${b.port}-tcp` });
        return ok({ id });
      }
      if (path.startsWith('inbounds/del/')) {
        const id = Number(path.split('/')[2]);
        const [gone] = inbounds.splice(
          inbounds.findIndex((i) => i.id === id),
          1,
        );
        // как RemoveInboundTagReferences 3X-UI: правило только с тегом удаляется, у прочих тег
        // убирается, само правило остаётся
        const routing = template.routing as { rules: Record<string, unknown>[] };
        routing.rules = routing.rules.flatMap((r) => {
          const tags = (r.inboundTag as string[] | undefined) ?? [];
          if (!tags.includes(String(gone?.tag))) return [r];
          const rest = tags.filter((t) => t !== gone?.tag);
          const { inboundTag: _, ...other } = r;
          if (!rest.length)
            return Object.keys(other).some((k) => !['type', 'ruleTag', 'outboundTag'].includes(k))
              ? [other]
              : [];
          return [{ ...r, inboundTag: rest }];
        });
        return ok(id);
      }
      if (path === 'server/status')
        return ok({ xray: { state: s.xray, errorMsg: s.xray === 'running' ? '' : 'boom' } });
      if (path === 'clients/list')
        return ok([...clients].map(([email, c]) => ({ email, inboundIds: c.inboundIds })));
      if (path.startsWith('clients/get/')) {
        const email = decodeURIComponent(path.split('/')[2] ?? '');
        const c = clients.get(email);
        return c
          ? ok({ client: { uuid: c.uuid, email, flow: c.flow }, inboundIds: c.inboundIds })
          : { status: 200, data: { success: false, msg: 'not found' } };
      }
      if (path === 'clients/add') {
        const b = body as { client: { email: string; flow: string }; inboundIds: number[] };
        clients.set(b.client.email, {
          uuid: `uuid-${b.client.email}`,
          flow: b.client.flow,
          inboundIds: b.inboundIds,
        });
        return ok(null);
      }
      const m = /^clients\/(del\/)?([^/]+)\/?(attach|detach)?$/.exec(path);
      if (m) {
        const email = decodeURIComponent(m[2] ?? '');
        if (m[1]) clients.delete(email);
        const c = clients.get(email);
        const ids = (body as { inboundIds?: number[] } | undefined)?.inboundIds ?? [];
        if (c && m[3] === 'attach') c.inboundIds.push(...ids);
        if (c && m[3] === 'detach') c.inboundIds = c.inboundIds.filter((x) => !ids.includes(x));
        return ok(null);
      }
      if (path === 'xray/')
        return ok(JSON.stringify({ xraySetting: template, outboundTestUrl: s.testUrl }));
      if (path === 'xray/geodata/files')
        return ok([{ name: 'geosite_RU.dat' }, { name: 'geoip_RU.dat' }, { name: 'geosite.dat' }]);
      if (path === 'xray/update') {
        s.writes++;
        template = JSON.parse(form?.xraySetting ?? '{}');
        s.testUrl = form?.outboundTestUrl ?? '';
        s.xray =
          s.breakAll || (s.breakOnWrite && JSON.stringify(template).includes('vp-cascade'))
            ? 'error'
            : 'running';
        return ok(null);
      }
      if (path.startsWith('inbounds/update/')) {
        const id = Number(path.split('/')[2]);
        const i = inbounds.findIndex((x) => x.id === id);
        const restoring = JSON.stringify(body) === JSON.stringify(s.original.get(id));
        if (!s.original.has(id)) s.original.set(id, inbounds[i]);
        inbounds[i] = { ...(body as Record<string, unknown>) };
        if (s.breakOnInboundUpdate) s.xray = restoring ? 'running' : 'error';
        return ok(null);
      }
      if (path === 'xray/testOutbound') {
        const tag = String((JSON.parse(form?.outbound ?? '{}') as { tag?: string }).tag);
        return s.deadOutbounds.has(tag)
          ? ok({ success: false, delay: 0, error: 'timeout' })
          : ok({ success: true, delay: 87 });
      }
      if (path === 'xray/geodata/validate')
        return ok(
          (form?.tokens ?? '')
            .split(',')
            .filter((t) => t.includes('no-such'))
            .map((token) => ({ token, reason: 'categoryMissing' })),
        );
      return { status: 404 };
    },
  };
  return s;
}

const rawInbound = (id: number, port: number) => ({
  id,
  remark: 'VLESS',
  port,
  enable: true,
  protocol: 'vless',
  tag: `in-${port}-tcp`,
  streamSettings: JSON.stringify({
    network: 'tcp',
    security: 'reality',
    realitySettings: {
      serverNames: ['example.com'],
      shortIds: ['ab'],
      settings: { publicKey: 'pk', fingerprint: 'firefox' },
    },
  }),
});

/** MTProxyL входа для каскада Telegram: маршруты, которые поставил скрипт панели. */
interface FakeMt {
  want: string;
  runs: { want: string; check: boolean; tests: string }[];
  /** Ошибка скрипта (ERR:...). */
  fail: string | null;
  /** Адрес, который отдаёт проверка маршрута. */
  ip: string;
}

async function setup(o: { mtproxyl?: boolean; panelHost?: boolean } = {}) {
  const db = createDb(':memory:');
  const box = new SecretBox('s'.repeat(40));
  for (const [id, name, host, country] of [
    ['entry', 'Kappa', '198.51.100.5', 'RU'],
    ['exit', 'NetCore', '203.0.113.20', 'SE'],
  ] as const) {
    db.insert(servers)
      .values({
        id,
        name,
        host,
        country,
        provider: name,
        statusCache: {
          inventory: {
            services: [
              { kind: 'xui' },
              ...(o.mtproxyl && id === 'entry' ? [{ kind: 'mtproxyl' }] : []),
            ],
            firewall: { listeners: [] },
          },
        },
      } as never)
      .run();
    await saveXuiToken(db, box, id, `tok-${id}`);
  }
  const xui: Record<string, ReturnType<typeof fakeXui>> = {
    entry: fakeXui(),
    exit: fakeXui({ inbounds: [rawInbound(7, 443)] }),
  };
  const online = new Set(['entry', 'exit']);
  const mt: FakeMt = { want: '', runs: [], fail: null, ip: '203.0.113.20' };
  const registry = {
    isOnline: (id: string) => online.has(id),
    supports: () => true,
    refreshInventory: async () => undefined,
    request: async (
      id: string,
      method: string,
      p: {
        method: string;
        path: string;
        body?: unknown;
        form?: Record<string, string>;
        env?: Record<string, string>;
      },
      opts?: { onStream?: (ch: string, chunk: string) => void },
    ) => {
      if (method === 'command.run' && id === 'entry') {
        const env = p.env ?? {};
        const want = env.WANT ?? '';
        const check = env.CHECK === '1';
        mt.runs.push({ want, check, tests: env.TESTS ?? '' });
        const say = (l: string) => opts?.onStream?.('stdout', `${l}\n`);
        if (mt.fail) {
          say(`ERR:${mt.fail}`);
          return { exitCode: 4 };
        }
        if (check) say(want === mt.want ? 'TG:same' : 'TG:diff');
        else if (want !== mt.want) {
          mt.want = want;
          say('TG:changed');
        }
        for (const n of (env.TESTS ?? '').split(' ').filter(Boolean))
          say(`TG:test=${n}=${mt.want.includes(n) ? mt.ip : ''}`);
        return { exitCode: 0 };
      }
      if (method !== 'xui.api' && method !== 'xui.form') throw new Error(method);
      return xui[id]?.handle(p.method, p.path, p.body, p.form);
    },
  };
  const journal = actionJournal(db, { broadcast: () => {} } as never, registry as never);
  const notes: string[] = [];
  let kicks = 0;
  const c = new Cascades({
    db,
    box,
    registry: registry as never,
    journal,
    gc: { kick: () => void kicks++ },
    log: { info: () => {}, warn: () => {} },
    notify: (_id, text) => void notes.push(text),
    checksMs: [1],
    inboundChecksMs: [1],
    panelHost: async () => Boolean(o.panelHost),
    recheckMs: 1,
  });
  const done = async () => {
    for (let i = 0; i < 200; i++) {
      const open = db
        .select()
        .from(actionLog)
        .all()
        .filter((a) => !a.finishedAt);
      if (!open.length) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    return db.select().from(actionLog).all().at(-1);
  };
  const input = {
    exitServerId: 'exit',
    exitInboundId: 7,
    port: 20443,
    target: 'ya.ru:443',
    serverNames: ['ya.ru'],
    fingerprint: 'firefox' as const,
    mode: 'ru-direct' as const,
    directList: [],
    exitList: [],
    blockQuic: false,
  };
  return { db, c, xui, online, done, input, notes, mt, kicks: () => kicks };
}

describe('каскады', () => {
  it('создание: клиент Vision на выходе, inbound входа, outbound и правила в шаблоне', async () => {
    const { db, c, xui, done, input, kicks } = await setup();
    await c.create('entry', input);
    const a = await done();
    expect(a?.exitCode, a?.output).toBe(0);
    const client = xui.exit?.clients.get(cascadeClientEmail('entry'));
    expect(client).toMatchObject({ flow: 'xtls-rprx-vision', inboundIds: [7] });
    const inb = xui.entry?.inbounds[0];
    expect(inb).toMatchObject({ port: 20443, remark: '\u2192 NetCore' });
    expect(JSON.parse(String(inb?.sniffing))).toMatchObject({ enabled: true, routeOnly: true });
    const t = JSON.stringify(xui.entry?.template);
    expect(t).toContain('"address":"203.0.113.20"');
    expect(t).toContain('"inboundTag":["in-20443-tcp"]');
    expect(t).toContain('geosite:openai'); // правило владельца на месте
    expect(xui.entry?.testUrl).toBe('https://example.com/204');
    const row = db.select().from(cascades).get();
    expect(row).toMatchObject({ entryPort: 20443, error: null, check: { ok: true, ms: 87 } });
    expect(kicks()).toBe(1);
  });

  it('Xray упал после записи шаблона - шаблон и inbound возвращаются, каскада нет', async () => {
    const { db, c, xui, done, input } = await setup();
    if (xui.entry) xui.entry.breakOnWrite = true;
    await c.create('entry', input);
    const a = await done();
    expect(a?.exitCode).toBe(1);
    expect(a?.output).toContain('шаблон возвращён');
    expect(db.select().from(cascades).all()).toEqual([]);
    expect(xui.entry?.inbounds).toEqual([]);
    expect(JSON.stringify(xui.entry?.template)).not.toContain('vp-cascade');
  });

  it('правка режима меняет правила; сверка без изменений шаблон не пишет', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    await c.edit(id, { mode: 'all', exitList: ['habr.com'] });
    const a = await done();
    expect(a?.exitCode, a?.output).toBe(0);
    const t = JSON.stringify(xui.entry?.template);
    expect(t).not.toContain('geoip:ru');
    expect(t).toContain('domain:habr.com');
    const writes = xui.entry?.writes ?? 0;
    await c.syncEntry('entry');
    expect(xui.entry?.writes).toBe(writes);
  });

  it('порт inbound-а выхода сменили - сверка переписывает outbound', async () => {
    const { c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const inb = xui.exit?.inbounds[0];
    if (inb) inb.port = 8443;
    await c.syncEntry('entry');
    expect(JSON.stringify(xui.entry?.template)).toContain('"port":8443');
  });

  it('удаление: шаблон чист, inbound входа удалён, служебный клиент на выходе удалён', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    c.remove(db.select().from(cascades).get()?.id ?? '');
    expect((await done())?.exitCode).toBe(0);
    expect(JSON.stringify(xui.entry?.template)).not.toContain('vp-cascade');
    expect(xui.entry?.inbounds).toEqual([]);
    expect(xui.exit?.clients.has(cascadeClientEmail('entry'))).toBe(false);
  });

  it('выход удалён из панели - каскад снимается со входа', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    await c.forget('exit');
    expect(db.select().from(cascades).all()).toEqual([]);
    expect(xui.entry?.inbounds).toEqual([]);
    expect(JSON.stringify(xui.entry?.template)).not.toContain('vp-cascade');
  });

  it('выход не в сети при удалении - служебного клиента убирает плановая сверка', async () => {
    const { db, c, xui, online, done, input } = await setup();
    // чужой клиент выхода сверка не трогает
    xui.exit?.clients.set('alice', { uuid: 'u-a', flow: '', inboundIds: [7] });
    await c.create('entry', input);
    await done();
    const email = cascadeClientEmail('entry');
    online.delete('exit');
    c.remove(db.select().from(cascades).get()?.id ?? '');
    const a = await done();
    expect(a?.output).toContain('плановой сверкой');
    expect(xui.exit?.clients.has(email)).toBe(true);
    online.add('exit');
    await c.syncAll();
    expect(xui.exit?.clients.has(email)).toBe(false);
    expect(xui.exit?.clients.has('alice')).toBe(true);
    const r = db.select().from(actionLog).all().at(-1);
    expect(r).toMatchObject({ serverId: 'exit', kind: 'cascade:release', exitCode: 0 });
  });

  it('плановая сверка: лишний inbound служебного клиента отвязывается, нужный остаётся', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const email = cascadeClientEmail('entry');
    const sc = xui.exit?.clients.get(email);
    if (sc) sc.inboundIds = [7, 8];
    await c.syncAll();
    expect(xui.exit?.clients.get(email)?.inboundIds).toEqual([7]);
    // вход удалён из панели, пока выход был не в сети: клиент удаляется
    db.delete(cascades).run();
    db.delete(servers).where(eq(servers.id, 'entry')).run();
    await c.sweepExits();
    expect(xui.exit?.clients.has(email)).toBe(false);
  });

  it('подписка: каскадная ссылка подписана по выходу и стоит после его прямой', async () => {
    const { db, c, done, input } = await setup();
    await c.create('entry', input);
    await done();
    db.insert(gclients)
      .values({ id: 'g', name: 'anna', slug: 'anna', token: 'tk' } as never)
      .run();
    for (const [sid, link] of [
      ['entry', 'vless://u@localhost:20443?security=reality#-%3E%20NetCore-anna'],
      ['exit', 'vless://u@localhost:443?security=reality#VLESS-anna'],
    ] as const)
      db.insert(gclientBindings)
        .values({
          id: `b-${sid}`,
          clientId: 'g',
          serverId: sid,
          service: 'xui',
          ref: 'anna',
          links: [link],
          state: 'ok',
        } as never)
        .run();
    const links = buildSubscription(db, 'tk')?.links ?? [];
    expect(links.map((l) => decodeURIComponent(l.split('#')[1] ?? ''))).toEqual([
      '\u{1F1F8}\u{1F1EA} Швеция :: NetCore',
      '\u{1F1F8}\u{1F1EA} Швеция :: NetCore через РФ',
    ]);
    expect(links[1]).toContain('@198.51.100.5:20443');

    // второй российский вход к тому же выходу: подписи различаются именем входа
    db.insert(servers)
      .values({ id: 'entry2', name: 'SkyHost', host: '198.51.100.9', country: 'RU' } as never)
      .run();
    db.insert(cascades)
      .values({
        id: 'c2',
        entryServerId: 'entry2',
        entryInboundId: 5,
        entryPort: 30443,
        exitServerId: 'exit',
        exitInboundId: 7,
      } as never)
      .run();
    db.insert(gclientBindings)
      .values({
        id: 'b-entry2',
        clientId: 'g',
        serverId: 'entry2',
        service: 'xui',
        ref: 'anna',
        links: ['vless://u@localhost:30443?security=reality#x-anna'],
        state: 'ok',
      } as never)
      .run();
    const two = (buildSubscription(db, 'tk')?.links ?? []).map((l) =>
      decodeURIComponent(l.split('#')[1] ?? ''),
    );
    expect(two).toEqual([
      '\u{1F1F8}\u{1F1EA} Швеция :: NetCore',
      '\u{1F1F8}\u{1F1EA} Швеция :: NetCore через РФ (Kappa)',
      '\u{1F1F8}\u{1F1EA} Швеция :: NetCore через РФ (SkyHost)',
    ]);
  });

  it('проверка: две неудачи подряд - уведомление, затем "снова работает"', async () => {
    const { db, c, xui, done, input, notes } = await setup();
    await c.create('entry', input);
    await done();
    const orig = xui.entry?.handle.bind(xui.entry);
    let up = false;
    if (xui.entry && orig)
      xui.entry.handle = (m, p, b, f) =>
        p === 'xray/testOutbound'
          ? ok(up ? { success: true, delay: 50 } : { success: false, error: 'timeout' })
          : orig(m, p, b, f);
    await c.checkAll();
    expect(notes).toEqual([]);
    await c.checkAll();
    expect(notes[0]).toContain('не работает: timeout');
    up = true;
    await c.checkAll();
    expect(notes[1]).toContain('снова работает');
    expect(
      db
        .select()
        .from(cascades)
        .where(eq(cascades.id, db.select().from(cascades).get()?.id ?? ''))
        .get()?.check?.ok,
    ).toBe(true);
  });
  it('правила каскада - на своём теге loopback-а; торренты и private - в блок первыми', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    const rules = (xui.entry?.template.routing as { rules: Record<string, unknown>[] }).rules;
    const own = rules.filter((r) => String(r.ruleTag ?? '').startsWith('vp-cascade-'));
    expect(own[0]).toMatchObject({
      inboundTag: ['in-20443-tcp'],
      outboundTag: `vp-cascade-${id}-lb`,
    });
    expect(
      own
        .slice(1)
        .every((r) => JSON.stringify(r.inboundTag) === JSON.stringify([`vp-cascade-${id}-in`])),
    ).toBe(true);
    expect(own[1]).toMatchObject({ ip: ['geoip:private'], outboundTag: 'vp-cascade-blocked' });
    expect(own[2]).toMatchObject({ protocol: ['bittorrent'] });
    const outs = (xui.entry?.template.outbounds as Record<string, unknown>[]).map((o) => o.tag);
    expect(outs).toContain(`vp-cascade-${id}-lb`);
  });

  it('inbound входа удалили в 3X-UI - правила каскада не становятся общими', async () => {
    const { c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const iid = Number(xui.entry?.inbounds[0]?.id);
    xui.entry?.handle('POST', `inbounds/del/${iid}`, undefined);
    const rules = (xui.entry?.template.routing as { rules: Record<string, unknown>[] }).rules;
    const own = rules.filter((r) => String(r.ruleTag ?? '').startsWith('vp-cascade-'));
    expect(own.length).toBeGreaterThan(0);
    expect(
      own.every(
        (r) => Array.isArray(r.inboundTag) && (r.inboundTag as string[])[0]?.endsWith('-in'),
      ),
    ).toBe(true);
    await c.syncEntry('entry');
    expect(JSON.stringify(xui.entry?.template)).not.toContain('vp-cascade');
  });

  it('временный сбой 3X-UI выхода - каскад остаётся как был', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const before = JSON.stringify(xui.entry?.template);
    if (xui.exit) xui.exit.exitDown = true;
    await c.syncEntry('entry');
    expect(JSON.stringify(xui.entry?.template)).toBe(before);
    expect(db.select().from(cascades).get()?.error).toBeNull();
  });

  it('inbound выхода удалён - трафик каскада в блок, а не напрямую', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    xui.exit?.inbounds.splice(0, 1);
    await c.syncEntry('entry');
    await done();
    const row = db.select().from(cascades).get();
    expect(row?.error).toContain('inbound выхода не найден');
    const own = (xui.entry?.template.routing as { rules: Record<string, unknown>[] }).rules.filter(
      (r) => String(r.ruleTag ?? '').startsWith('vp-cascade-'),
    );
    expect(own).toEqual([
      {
        type: 'field',
        ruleTag: `vp-cascade-${row?.id}-entry`,
        inboundTag: ['in-20443-tcp'],
        outboundTag: 'vp-cascade-blocked',
      },
    ]);
  });

  it('удаление не удалось (Xray упал) - каскад и inbound остаются', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    if (xui.entry) xui.entry.breakAll = true;
    c.remove(db.select().from(cascades).get()?.id ?? '');
    const a = await done();
    expect(a?.exitCode).toBe(1);
    expect(a?.output).toMatch(/Xray/);
    expect(db.select().from(cascades).all()).toHaveLength(1);
    expect(xui.entry?.inbounds).toHaveLength(1);
  });

  it('неверные строки и категории списков - отказ до действия', async () => {
    const { c, input } = await setup();
    await expect(c.create('entry', { ...input, exitList: ['999.1.1.1/99'] })).rejects.toThrow(
      /не понятны/,
    );
    await expect(c.create('entry', { ...input, exitList: ['regexp:('] })).rejects.toThrow(
      /не понятны/,
    );
    await expect(c.create('entry', { ...input, directList: ['geosite:no-such'] })).rejects.toThrow(
      /нет таких категорий/,
    );
  });

  it('правка цели Reality: inbound входа с новой целью и теми же ключами, синхронизация', async () => {
    const { db, c, xui, done, input, kicks } = await setup();
    await c.create('entry', input);
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    const reality = (i: unknown) =>
      JSON.parse(String((i as { streamSettings: string }).streamSettings)).realitySettings;
    const before = reality(xui.entry?.inbounds[0]);
    const writes = xui.entry?.writes ?? 0;
    await c.edit(id, { target: 'vk.com:443', serverNames: ['vk.com'], fingerprint: 'chrome' });
    const a = await done();
    expect(a?.exitCode, a?.output).toBe(0);
    const after = reality(xui.entry?.inbounds[0]);
    expect(after).toMatchObject({ target: 'vk.com:443', serverNames: ['vk.com'] });
    expect(after.settings.fingerprint).toBe('chrome');
    expect(after.privateKey).toBe(before.privateKey);
    expect(after.shortIds).toEqual(before.shortIds);
    expect(xui.entry?.writes).toBe(writes); // шаблон не трогали
    expect(kicks()).toBe(2);
  });

  it('правка цели Reality остановила Xray - inbound входа возвращается как был', async () => {
    const { db, c, xui, done, input, kicks } = await setup();
    await c.create('entry', input);
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    const was = JSON.stringify(xui.entry?.inbounds[0]);
    if (xui.entry) xui.entry.breakOnInboundUpdate = true;
    await c.edit(id, { target: 'vk.com:443', serverNames: ['vk.com'], mode: 'all' });
    const a = await done();
    expect(a?.exitCode).toBe(1);
    expect(a?.output).toContain('возвращён как был');
    expect(JSON.stringify(xui.entry?.inbounds[0])).toBe(was);
    expect(db.select().from(cascades).get()?.mode).toBe('ru-direct');
    expect(kicks()).toBe(1);
  });

  it('цель Reality без имён - 400', async () => {
    const { db, c, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    await expect(c.edit(id, { target: 'vk.com:443' })).rejects.toThrow(/вместе/);
  });

  it('пустая правка - 400', async () => {
    const { db, c, done, input } = await setup();
    await c.create('entry', input);
    await done();
    await expect(c.edit(db.select().from(cascades).get()?.id ?? '', {})).rejects.toThrow(/нечего/);
  });
  it('подпись входа прежнего вида "-> выход" сверка меняет на стрелку', async () => {
    const { db, c, xui, done, input } = await setup();
    await c.create('entry', input);
    await done();
    const inb = xui.entry?.inbounds[0];
    if (inb) inb.remark = '-> NetCore';
    await c.syncEntry('entry');
    await done();
    expect(xui.entry?.inbounds[0]?.remark).toBe('\u2192 NetCore');
    expect(db.select().from(cascades).get()?.entryRemark).toBe('\u2192 NetCore');
  });
});

describe('каскад Telegram', () => {
  const tpl = (x: ReturnType<typeof fakeXui> | undefined) =>
    x?.template as {
      inbounds?: Record<string, unknown>[];
      routing: { rules: Record<string, unknown>[] };
    };

  it('создание с отметкой: socks-inbound на 127.0.0.1, правило на выход, маршрут MTProxyL', async () => {
    const { db, c, xui, done, input, mt } = await setup({ mtproxyl: true });
    await c.create('entry', { ...input, telegram: true });
    const a = await done();
    expect(a?.exitCode, a?.output).toBe(0);
    const row = db.select().from(cascades).get();
    expect(row).toMatchObject({ telegram: true, telegramMain: true });
    const port = Number(row?.telegramPort);
    expect(port).toBeGreaterThan(0);
    const inb = tpl(xui.entry).inbounds?.find((i) => i.tag === `vp-cascade-${row?.id}-tg`);
    expect(inb).toMatchObject({ listen: '127.0.0.1', port, protocol: 'socks' });
    const rule = tpl(xui.entry).routing.rules.find((r) => r.ruleTag === `vp-cascade-${row?.id}-tg`);
    expect(rule).toMatchObject({ outboundTag: `vp-cascade-${row?.id}` });
    expect(mt.want).toBe(`vpc-${row?.id}:${port}:10`);
    expect(row?.telegramCheck).toMatchObject({ ok: true, ip: '203.0.113.20' });
    expect(a?.output).toContain('Telegram выходит через 203.0.113.20');
    // проверка по кнопке - и путь Telegram
    await c.check(row?.id ?? '');
    expect(mt.runs.at(-1)).toMatchObject({ check: true, tests: `vpc-${row?.id}` });
  });

  it('два основных - поровну; запасной без трафика; роль меняется правкой', async () => {
    const { db, c, xui, done, input, mt } = await setup({ mtproxyl: true });
    xui.exit?.inbounds.push(rawInbound(8, 8443), rawInbound(9, 9443));
    await c.create('entry', { ...input, telegram: true });
    await done();
    await c.create('entry', { ...input, exitInboundId: 8, port: 20444, telegram: true });
    await done();
    await c.create('entry', {
      ...input,
      exitInboundId: 9,
      port: 20445,
      telegram: true,
      telegramMain: false,
    });
    expect((await done())?.exitCode).toBe(0);
    const [a, b, sp] = db.select().from(cascades).all();
    expect([a?.telegramMain, b?.telegramMain, sp?.telegramMain]).toEqual([true, true, false]);
    expect(mt.want).toBe(
      [`vpc-${a?.id}:${a?.telegramPort}:10`, `vpc-${b?.id}:${b?.telegramPort}:10`].join(' '),
    );
    const v = (await c.list('entry')).cascades;
    expect(v.find((x) => x.id === sp?.id)?.telegramActive).toBe(false);
    // запасной стал основным - в маршрутах все три
    await c.edit(sp?.id ?? '', { telegramMain: true });
    expect((await done())?.exitCode).toBe(0);
    expect(mt.want.split(' ')).toHaveLength(3);
    // основной стал запасным - его нет в маршрутах, роль других не меняется
    await c.edit(a?.id ?? '', { telegramMain: false });
    expect((await done())?.exitCode).toBe(0);
    expect(mt.want).not.toContain(`vpc-${a?.id}`);
    expect(
      db
        .select()
        .from(cascades)
        .all()
        .map((r) => r.telegramMain),
    ).toEqual([false, true, true]);
    // удаление основного - остальные как были
    c.remove(b?.id ?? '');
    expect((await done())?.exitCode).toBe(0);
    expect(mt.want).toBe(`vpc-${sp?.id}:${sp?.telegramPort}:10`);
  });

  it('снятие последней отметки - маршруты MTProxyL как были, socks-inbound-а нет', async () => {
    const { db, c, xui, done, input, mt } = await setup({ mtproxyl: true });
    await c.create('entry', { ...input, telegram: true });
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    await c.edit(id, { telegram: false });
    expect((await done())?.exitCode).toBe(0);
    expect(mt.want).toBe('');
    expect(db.select().from(cascades).get()).toMatchObject({
      telegram: false,
      telegramMain: false,
      telegramPort: null,
    });
    expect(JSON.stringify(xui.entry?.template)).not.toContain('-tg');
    // MTProxyL больше не трогается
    const runs = mt.runs.length;
    await c.syncEntry('entry');
    expect(mt.runs.length).toBe(runs);
  });

  it('нет MTProxyL или сервер панели - отметку не поставить', async () => {
    const a = await setup();
    await expect(a.c.create('entry', { ...a.input, telegram: true })).rejects.toThrow(
      'нет MTProxyL',
    );
    expect((await a.c.list('entry')).telegram).toMatchObject({ available: false });
    const b = await setup({ mtproxyl: true, panelHost: true });
    await expect(b.c.create('entry', { ...b.input, telegram: true })).rejects.toThrow(
      'сервере панели',
    );
  });

  it('MTProxyL отказал - каскад есть, отметка снята, шаблон без пути Telegram', async () => {
    const { db, c, xui, done, input, mt } = await setup({ mtproxyl: true });
    mt.fail = 'в MTProxyL включён маршрут warp';
    await c.create('entry', { ...input, telegram: true });
    const a = await done();
    expect(a?.exitCode).toBe(1);
    expect(a?.output).toContain('Telegram через него не настроен');
    expect(db.select().from(cascades).get()).toMatchObject({ telegram: false, telegramPort: null });
    expect(JSON.stringify(xui.entry?.template)).not.toContain('-tg');
    expect((await c.list('entry')).telegram.error).toContain('warp');
  });

  it('сверка: маршруты MTProxyL разошлись с отметками - ставятся заново', async () => {
    const { c, done, input, mt } = await setup({ mtproxyl: true });
    await c.create('entry', { ...input, telegram: true });
    await done();
    const want = mt.want;
    mt.want = '';
    await c.syncEntry('entry');
    await done();
    expect(mt.want).toBe(want);
  });

  it('основной выход лёг - Telegram через запасной; вернулся - снова через основной', async () => {
    const { db, c, xui, done, input, mt } = await setup({ mtproxyl: true });
    xui.exit?.inbounds.push(rawInbound(8, 8443));
    await c.create('entry', { ...input, telegram: true });
    await done();
    await c.create('entry', {
      ...input,
      exitInboundId: 8,
      port: 20444,
      telegram: true,
      telegramMain: false,
    });
    await done();
    const [main, spare] = db.select().from(cascades).all();
    expect(mt.want).toBe(`vpc-${main?.id}:${main?.telegramPort}:10`);
    xui.entry?.deadOutbounds.add(`vp-cascade-${main?.id}`);
    await c.checkAll();
    await done();
    expect(mt.want).toBe(`vpc-${spare?.id}:${spare?.telegramPort}:10`);
    const v = (await c.list('entry')).cascades;
    expect(v.find((x) => x.id === main?.id)).toMatchObject({
      telegramDown: true,
      telegramMain: true,
    });
    expect(v.find((x) => x.id === spare?.id)).toMatchObject({ telegramActive: true });
    xui.entry?.deadOutbounds.clear();
    await c.checkAll();
    await done();
    expect(mt.want).toBe(`vpc-${main?.id}:${main?.telegramPort}:10`);
  });

  it('один сбой проверки - Telegram не перестраивается', async () => {
    const { db, c, xui, done, input, mt } = await setup({ mtproxyl: true });
    await c.create('entry', { ...input, telegram: true });
    await done();
    const want = mt.want;
    const runs = mt.runs.length;
    const id = db.select().from(cascades).get()?.id;
    // повторная проверка проходит: сбой разовый
    let n = 0;
    const orig = xui.entry?.handle.bind(xui.entry);
    if (xui.entry && orig)
      xui.entry.handle = (m, path, b, f) =>
        path === 'xray/testOutbound' && n++ === 0
          ? ok({ success: false, delay: 0, error: 'timeout' })
          : orig(m, path, b, f);
    await c.checkAll();
    expect(mt.want).toBe(want);
    expect(mt.runs.length).toBe(runs);
    expect((await c.list('entry')).cascades.find((x) => x.id === id)?.telegramDown).toBe(false);
  });

  it('правка с режимом и отметкой: MTProxyL отказал - режим остался, отметка - как была', async () => {
    const { db, c, done, input, mt } = await setup({ mtproxyl: true });
    await c.create('entry', input);
    await done();
    const id = db.select().from(cascades).get()?.id ?? '';
    mt.fail = 'в MTProxyL включён маршрут warp';
    await c.edit(id, { mode: 'all', telegram: true });
    const a = await done();
    expect(a?.exitCode).toBe(1);
    expect(db.select().from(cascades).get()).toMatchObject({ mode: 'all', telegram: false });
  });

  it('проверка: адрес входа вместо выхода - "не проходит"', async () => {
    const { db, c, done, input, mt } = await setup({ mtproxyl: true });
    await c.create('entry', { ...input, telegram: true });
    await done();
    mt.ip = '198.51.100.5';
    const id = db.select().from(cascades).get()?.id ?? '';
    await c.check(id);
    expect(db.select().from(cascades).get()?.telegramCheck).toMatchObject({
      ok: false,
      ip: '198.51.100.5',
    });
  });
});
