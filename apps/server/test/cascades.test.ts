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
      if (path === 'xray/testOutbound') return ok({ success: true, delay: 87 });
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

async function setup() {
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
        statusCache: { inventory: { services: [{ kind: 'xui' }], firewall: { listeners: [] } } },
      } as never)
      .run();
    await saveXuiToken(db, box, id, `tok-${id}`);
  }
  const xui: Record<string, ReturnType<typeof fakeXui>> = {
    entry: fakeXui(),
    exit: fakeXui({ inbounds: [rawInbound(7, 443)] }),
  };
  const online = new Set(['entry', 'exit']);
  const registry = {
    isOnline: (id: string) => online.has(id),
    supports: () => true,
    refreshInventory: async () => undefined,
    request: async (
      id: string,
      method: string,
      p: { method: string; path: string; body?: unknown; form?: Record<string, string> },
    ) => {
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
  return { db, c, xui, online, done, input, notes, kicks: () => kicks };
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
    await c.remove(db.select().from(cascades).get()?.id ?? '');
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
    await c.remove(db.select().from(cascades).get()?.id ?? '');
    const a = db.select().from(actionLog).all().at(-1);
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
    await expect(c.remove(db.select().from(cascades).get()?.id ?? '')).rejects.toThrow(/Xray/);
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
