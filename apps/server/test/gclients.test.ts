import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { type Db, createDb } from '../src/db/index.js';
import {
  awgClients,
  gclientBindings,
  gclientDevices,
  gclients,
  servers,
} from '../src/db/schema.js';
import { clientSlug, newClientToken, newXuiSubId } from '../src/lib/gclient-names.js';
import { awgRef } from '../src/lib/gclient-services.js';
import { GClients, PANEL_HOST_KEY, queued } from '../src/lib/gclients.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { putSetting } from '../src/lib/settings.js';

/** Имитация 3X-UI v3 на сервере: inbound-ы, клиенты, ссылки подписки. */
function fakeXui() {
  const inbounds = [
    { id: 1, protocol: 'vless', enable: true, remark: 'reality' },
    { id: 2, protocol: 'vless', enable: true, remark: 'xhttp' },
    { id: 3, protocol: 'vmess', enable: true, remark: 'old' },
    { id: 4, protocol: 'vless', enable: true, remark: 'node', nodeId: 7 },
  ];
  const clients = new Map<
    string,
    { uuid: string; enable: boolean; subId: string; flow: string; inboundIds: number[] }
  >();
  const ok = (obj?: unknown) => ({ status: 200, data: { success: true, obj } });
  const handle = (method: string, path: string, body: Record<string, unknown> | null) => {
    if (path === 'inbounds/list') return ok(inbounds);
    let m = /^clients\/get\/(.+)$/.exec(path);
    if (m) {
      const c = clients.get(decodeURIComponent(m[1] ?? ''));
      return c
        ? ok({
            client: { uuid: c.uuid, email: m[1], subId: c.subId, enable: c.enable, flow: c.flow },
            inboundIds: c.inboundIds,
          })
        : { status: 200, data: { success: false, msg: 'client not found' } };
    }
    if (path === 'clients/add') {
      const c = body?.client as Record<string, unknown>;
      clients.set(String(c.email), {
        uuid: `uuid-${c.email}`,
        enable: c.enable !== false,
        subId: String(c.subId),
        flow: '',
        inboundIds: body?.inboundIds as number[],
      });
      return ok();
    }
    m = /^clients\/(.+)\/(attach|detach)$/.exec(path);
    if (m) {
      const c = clients.get(decodeURIComponent(m[1] ?? ''));
      if (!c) return { status: 200, data: { success: false, msg: 'not found' } };
      const ids = body?.inboundIds as number[];
      c.inboundIds =
        m[2] === 'attach'
          ? [...c.inboundIds, ...ids]
          : c.inboundIds.filter((i) => !ids.includes(i));
      return ok();
    }
    m = /^clients\/update\/(.+)$/.exec(path);
    if (m) {
      const c = clients.get(decodeURIComponent(m[1] ?? ''));
      if (!c) return { status: 200, data: { success: false, msg: 'not found' } };
      Object.assign(c, { enable: body?.enable, subId: body?.subId, flow: body?.flow });
      return ok();
    }
    m = /^clients\/del\/(.+)$/.exec(path);
    if (m) {
      clients.delete(decodeURIComponent(m[1] ?? ''));
      return ok();
    }
    m = /^clients\/subLinks\/(.+)$/.exec(path);
    if (m) {
      const [email, c] = [...clients].find(([, x]) => x.subId === m?.[1]) ?? [];
      return ok(
        c
          ? c.inboundIds.map((i) => `vless://${c.uuid}@127.0.0.1:443?type=tcp#in${i}-${email}`)
          : [],
      );
    }
    return { status: 404, data: null };
  };
  return { inbounds, clients, handle };
}

/** Имитация агента AWG: экземпляры с пирами, операции awg.exec. */
function fakeAwg(versions: string[]) {
  const instances = versions.map((v, i) => ({
    container: i === 0 ? 'amnezia-awg2' : `amnezia-awg2-4000${i}`,
    version: v,
    state: 'running',
    clients: [] as {
      publicKey: string;
      name: string;
      device?: string | undefined;
      disabled: boolean;
      inConfig: boolean;
    }[],
  }));
  const exec = (p: { op: string; container: string; args: Record<string, string> }) => {
    const inst = instances.find((x) => x.container === p.container);
    if (!inst) throw new Error('нет контейнера');
    const peer = inst.clients.find((c) => c.publicKey === p.args.publicKey);
    if (p.op === 'client.add')
      inst.clients.push({
        publicKey: p.args.publicKey ?? '',
        name: p.args.name ?? '',
        device: p.args.device,
        disabled: false,
        inConfig: true,
      });
    else if (!peer) throw new Error('клиент не найден');
    else if (p.op === 'client.remove') inst.clients = inst.clients.filter((c) => c !== peer);
    else if (p.op === 'client.disable') Object.assign(peer, { disabled: true, inConfig: false });
    else if (p.op === 'client.enable') Object.assign(peer, { disabled: false, inConfig: true });
    else if (p.op === 'client.rename')
      Object.assign(peer, { name: p.args.name, device: p.args.device });
    return { ok: true };
  };
  return { instances, exec };
}

/** Имитация MTProxyL: пользователи с секретами, операции mtproxyl.exec. */
function fakeMt() {
  const users = new Map<string, { secret: string; enabled: boolean }>();
  const exec = (p: { op: string; args: Record<string, string> }) => {
    const label = p.args.label ?? '';
    const u = users.get(label);
    if (p.op === 'secret.add') {
      if (u) throw new Error(`Секрет '${label}' уже существует`);
      users.set(label, { secret: p.args.secret ?? 'gen', enabled: true });
      return { ok: true, output: '' };
    }
    if (!u) throw new Error(`Секрет '${label}' не найден`);
    if (p.op === 'secret.disable') u.enabled = false;
    if (p.op === 'secret.enable') u.enabled = true;
    if (p.op === 'secret.remove') users.delete(label);
    if (p.op === 'secret.link')
      return { ok: true, output: `tg://proxy?server=1.2.3.4&port=443&secret=ee${u.secret}\n` };
    return { ok: true, output: '' };
  };
  return { users, exec };
}

/** admin API wdtt-server: пароли генерирует сервер, у пароля без устройств device_ids - null. */
function fakeWdtt() {
  const passwords = new Map<
    string,
    { label: string; max_devices: number; expires_at: number; is_deactivated: boolean }
  >();
  let n = 0;
  const res = (status: number, data: unknown) => ({ status, dtlsPort: 56000, wgPort: 56001, data });
  const view = (pw: string) => ({ password: pw, device_ids: null, ...passwords.get(pw) });
  const handle = (p: { method: string; path: string; form: Record<string, string> }) => {
    const now = Math.floor(Date.now() / 1000);
    if (p.method === 'GET') return res(200, { passwords: [...passwords.keys()].map(view) });
    if (p.path === '/admin/passwords') {
      const pw = `pw${++n}`;
      passwords.set(pw, {
        label: p.form.label ?? '',
        max_devices: Number(p.form.max_devices),
        expires_at: now + Number(p.form.days) * 86400,
        is_deactivated: false,
      });
      return res(200, view(pw));
    }
    const e = passwords.get(p.form.password ?? '');
    if (!e) return res(404, { error: 'password not found' });
    if (p.path.endsWith('/update')) {
      if (p.form.label) e.label = p.form.label;
      if (p.form.max_devices) e.max_devices = Number(p.form.max_devices);
      if (p.form.days) e.expires_at = now + Number(p.form.days) * 86400;
    }
    if (p.path.endsWith('/deactivate')) e.is_deactivated = true;
    if (p.path.endsWith('/activate')) e.is_deactivated = false;
    if (p.path.endsWith('/delete')) passwords.delete(p.form.password ?? '');
    return res(200, { ok: true });
  };
  return { passwords, handle };
}

let dir: string;
let db: Db;
let wd: Record<string, ReturnType<typeof fakeWdtt>>;
let xui: Record<string, ReturnType<typeof fakeXui>>;
let awg: Record<string, ReturnType<typeof fakeAwg>>;
let mt: Record<string, ReturnType<typeof fakeMt>>;
let nv: Record<string, Map<string, string>>;
let busy: Set<string>;
const journal = {
  log: [] as { serverId: string; exitCode: number; output: string }[],
  /** Вывод по ходу (консоль на странице сервера): сервер -> куски. */
  streamed: {} as Record<string, string>,
  open(serverId: string) {
    if (busy.has(serverId)) throw Object.assign(new Error('занят'), { statusCode: 409 });
    return {
      id: serverId,
      output: '',
      stream(_channel: string, chunk: string) {
        journal.streamed[serverId] = (journal.streamed[serverId] ?? '') + chunk;
      },
      async finish(exitCode: number, output = '') {
        journal.log.push({ serverId, exitCode, output });
      },
    };
  },
};
const registry = {
  isOnline: () => true,
  isUpdating: () => false,
  latestMetrics: () => undefined,
  request: async (
    serverId: string,
    method: string,
    p: { method: string; path: string; body: Record<string, unknown> | null },
  ) => {
    if (method === 'xui.token') return { token: 't' };
    if (method === 'xui.api') return xui[serverId]?.handle(p.method, p.path, p.body);
    if (method === 'awg.status') return { instances: awg[serverId]?.instances ?? [], docker: true };
    if (method === 'awg.exec') return awg[serverId]?.exec(p as never);
    if (method === 'mtproxyl.status')
      return { secrets: [...(mt[serverId]?.users ?? [])].map(([label, u]) => ({ label, ...u })) };
    if (method === 'mtproxyl.exec') return mt[serverId]?.exec(p as never);
    if (method === 'wdtt.api') return wd[serverId]?.handle(p as never);
    // прокси для браузера (agent naive.status / naive.exec): пользователи - имя -> пароль
    if (method === 'naive.status')
      return {
        installed: true,
        domain: `${serverId}.example.com`,
        port: 8444,
        mask443: true,
        secret: 'probe.test',
        users: [...(nv[serverId]?.keys() ?? [])],
      };
    if (method === 'naive.exec') {
      const q = p as unknown as { op: string; user: string; pass: string };
      if (q.op === 'user.set') nv[serverId]?.set(q.user, q.pass);
      if (q.op === 'user.remove') nv[serverId]?.delete(q.user);
      return { ok: true };
    }
    throw new Error(`неожиданный вызов ${method}`);
  },
} as unknown as AgentRegistry;
// настоящее шифрование: ошибки seal/open в сверке тест должен видеть
const box = new SecretBox('x'.repeat(32));
const inventory = {
  services: [
    { kind: 'xui', title: '3X-UI', ports: [] },
    { kind: 'amnezia', title: 'Amnezia awg2', ports: [] },
    { kind: 'mtproxyl', title: 'MTProxyL', ports: [] },
  ],
  audit: { fail2banJails: [] },
  firewall: { ufwActive: true, dockerFiltered: true },
  host: {},
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gc-'));
  db = createDb(dir);
  xui = { s1: fakeXui(), s2: fakeXui() };
  awg = { s1: fakeAwg(['3.1', '2.0']), s2: fakeAwg(['3.1']) };
  mt = { s1: fakeMt(), s2: fakeMt() };
  wd = { s1: fakeWdtt(), s2: fakeWdtt() };
  nv = { s1: new Map(), s2: new Map() };
  busy = new Set();
  journal.log = [];
  journal.streamed = {};
  for (const id of ['s1', 's2'])
    db.insert(servers)
      .values({
        id,
        name: id,
        host: `${id}.example`,
        agentTokenHash: 'x',
        statusCache: { inventory },
      } as never)
      .run();
  db.update(servers)
    .set({ xuiExcluded: [2] })
    .where(eq(servers.id, 's2'))
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const mk = (name: string) => {
  const c = {
    id: name,
    name,
    slug: clientSlug(name),
    token: newClientToken(),
    xuiSubId: newXuiSubId(),
  };
  db.insert(gclients).values(c).run();
  return c;
};

describe('clientSlug', () => {
  it('транслит и хвост', () => {
    expect(clientSlug('Иван Петров')).toMatch(/^ivan-petrov-[0-9a-f]{4}$/);
    expect(clientSlug('!!!')).toMatch(/^client-[0-9a-f]{4}$/);
  });
});

describe('GClients.reconcile: 3X-UI', () => {
  it('создаёт клиента во всех своих VLESS-inbound-ах, кроме исключённых, с subId и Vision', async () => {
    const c = mk('Иван');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const s1 = xui.s1?.clients.get(c.slug);
    // subId в 3X-UI - свой, не токен личной страницы
    expect(s1?.subId).not.toBe(c.token);
    expect(s1).toMatchObject({
      subId: c.xuiSubId,
      flow: 'xtls-rprx-vision',
      enable: true,
      inboundIds: [1, 2],
    });
    // на s2 inbound 2 исключён; vmess и inbound узла мастера не берутся нигде
    expect(xui.s2?.clients.get(c.slug)?.inboundIds).toEqual([1]);
    const b = db
      .select()
      .from(gclientBindings)
      .all()
      .filter((x) => x.service === 'xui');
    expect(b.map((x) => x.state)).toEqual(['ok', 'ok']);
    expect(b.find((x) => x.serverId === 's1')?.links).toHaveLength(2);
    expect(journal.log.map((x) => x.exitCode)).toEqual([0, 0]);
    // вывод идёт по ходу, а не только итогом в журнал
    expect(journal.streamed.s1).toMatch(/^Синхронизация клиентов: изменений \d+\n/);

    // повторная сверка ничего не делает: всё ok
    await g.reconcile();
    expect(journal.log).toHaveLength(2);
  });

  it('сервер панели: клиенты только после явного включения', async () => {
    const c = mk('Оля');
    // s1 - сервер панели: его адрес - адрес домена панели
    const g = new GClients(db, box, registry, journal, async () => ['s1.example'], {
      warn: () => {},
    });
    await g.reconcile();
    expect(xui.s1?.clients.get(c.slug)).toBeUndefined();
    expect(xui.s2?.clients.get(c.slug)).toBeTruthy();
    const st = (await g.serverStates()).find((t) => t.row.id === 's1');
    expect(st).toMatchObject({ panelHost: true, enabled: false, active: false });

    putSetting(db, PANEL_HOST_KEY, '1');
    db.update(gclientBindings).set(queued()).run();
    await g.reconcile();
    expect(xui.s1?.clients.get(c.slug)).toBeTruthy();
  });

  it('выключение, исключение сервера, удаление клиента; занятый сервер ждёт', async () => {
    const c = mk('Петя');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    // выключили клиента: маршруты ставят привязкам pending
    db.update(gclients).set({ enabled: false }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    busy.add('s2');
    await g.reconcile();
    expect(xui.s1?.clients.get(c.slug)?.enable).toBe(false);
    expect(xui.s2?.clients.get(c.slug)?.enable).toBe(true);
    expect(
      db
        .select()
        .from(gclientBindings)
        .all()
        .find((b) => b.serverId === 's2')?.state,
    ).toBe('pending');
    busy.clear();
    // s2 исключили из глобальных клиентов - клиент оттуда удаляется
    db.update(servers).set({ gclients: false }).where(eq(servers.id, 's2')).run();
    await g.reconcile();
    expect(xui.s2?.clients.has(c.slug)).toBe(false);
    expect(
      db
        .select()
        .from(gclientBindings)
        .all()
        .filter((b) => b.service === 'xui')
        .map((b) => b.serverId),
    ).toEqual(['s1']);
    // удалили клиента: записи на серверах и строки в базе исчезают
    db.update(gclients).set({ deletedAt: new Date().toISOString() }).run();
    await g.reconcile();
    expect(xui.s1?.clients.size).toBe(0);
    expect(db.select().from(gclients).all()).toEqual([]);
  });

  it('свой набор inbound-ов клиента держится сверкой; пропавший inbound - ошибка; null - как у всех', async () => {
    const c = mk('Оля');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    expect(xui.s1?.clients.get(c.slug)?.inboundIds).toEqual([1, 2]);
    const only = (v: number[] | null) =>
      db
        .update(gclientBindings)
        .set({ ...queued(), xuiInbounds: v })
        .where(eq(gclientBindings.serverId, 's1'))
        .run();
    only([2]);
    await g.reconcile();
    expect(xui.s1?.clients.get(c.slug)?.inboundIds).toEqual([2]);
    // inbound 3 (vmess) и 99 (нет) в своём наборе не берутся; ничего не осталось - ошибка
    only([3, 99]);
    await g.reconcile();
    const b = db
      .select()
      .from(gclientBindings)
      .all()
      .find((x) => x.serverId === 's1' && x.service === 'xui');
    expect(b?.state).toBe('error');
    expect(b?.error).toContain('из набора клиента');
    only(null);
    await g.reconcile();
    expect(xui.s1?.clients.get(c.slug)?.inboundIds.sort()).toEqual([1, 2]);
  });
});

describe('GClients.reconcile: VLESS-inbound-ов на сервере не осталось', () => {
  it('все удалены - ссылок нет, не ошибка; все исключены - ошибка, ссылок тоже нет', async () => {
    mk('Ника');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const xb = (id: string) =>
      db
        .select()
        .from(gclientBindings)
        .all()
        .find((x) => x.serverId === id && x.service === 'xui');
    expect(xb('s1')?.links).toHaveLength(2);
    // s1: все свои VLESS удалены (остались vmess и inbound узла)
    const s1 = xui.s1;
    if (!s1) throw new Error('нет s1');
    s1.inbounds.splice(0, 2);
    // s2: оба оставшихся исключены
    db.update(servers)
      .set({ xuiExcluded: [1, 2] })
      .where(eq(servers.id, 's2'))
      .run();
    db.update(gclientBindings).set(queued()).run();
    await g.reconcile();
    expect(xb('s1')).toMatchObject({ state: 'ok', error: '', links: [] });
    expect(xb('s2')?.state).toBe('error');
    expect(xb('s2')?.error).toContain('исключены');
    expect(xb('s2')?.links).toEqual([]);
  });
});

describe('GClients.reconcile: AWG на устройство', () => {
  it('пиры на 3.1 и 2.0, имена и ключи; нет 2.0 - не заводится; галочка, выключение, удаление', async () => {
    const c = mk('Иван');
    db.insert(gclientDevices)
      .values({ id: 'd1', clientId: c.id, name: 'телефон', type: 'ios', awg20: true })
      .run();
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const peers = (sid: string) =>
      awg[sid]?.instances.map((i) => i.clients.map((p) => `${p.name}|${p.device}|${p.disabled}`));
    expect(peers('s1')).toEqual([
      ['Иван (iPhone/iPad: телефон)|ios|false'],
      ['Иван (iPhone/iPad: телефон)|ios|false'],
    ]);
    expect(peers('s2')).toEqual([['Иван (iPhone/iPad: телефон)|ios|false']]);
    const awgB = () =>
      db
        .select()
        .from(gclientBindings)
        .all()
        .filter((b) => b.service === 'awg');
    // на s2 экземпляра 2.0 нет - привязки нет вовсе, ошибки тоже
    expect(
      awgB()
        .filter((b) => b.serverId === 's2')
        .map((b) => awgRef(b.ref).major),
    ).toEqual(['3']);
    expect(db.select().from(awgClients).all()).toHaveLength(3);
    // привязка к версии, которой на сервере нет (заведена раньше), убирается сверкой без ошибки
    db.insert(gclientBindings)
      .values({
        id: 'stale',
        clientId: c.id,
        deviceId: 'd1',
        serverId: 's2',
        service: 'awg',
        ref: '2||',
        state: 'error',
        error: 'нет экземпляра',
        // ошибка давняя: повтор ошибок - не чаще раза в 30 минут
        updatedAt: new Date(Date.now() - 60 * 60_000).toISOString(),
      })
      .run();
    await g.reconcile();
    expect(awgB().some((b) => b.id === 'stale')).toBe(false);

    // сняли галочку 2.0 - пир на экземпляре 2.0 убирается, ключ забывается
    db.update(gclientDevices).set({ awg20: false }).run();
    await g.reconcile();
    expect(peers('s1')).toEqual([['Иван (iPhone/iPad: телефон)|ios|false'], []]);
    expect(awgB().map((b) => awgRef(b.ref).major)).toEqual(['3', '3']);
    expect(db.select().from(awgClients).all()).toHaveLength(2);

    // выключили клиента - пиры выключены
    db.update(gclients).set({ enabled: false }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(peers('s1')?.[0]).toEqual(['Иван (iPhone/iPad: телефон)|ios|true']);

    // удалили устройство - пиры и ключи убраны, строка устройства стёрта
    db.update(gclientDevices).set({ deletedAt: new Date().toISOString() }).run();
    await g.reconcile();
    expect(peers('s1')).toEqual([[], []]);
    expect(db.select().from(awgClients).all()).toEqual([]);
    expect(db.select().from(gclientDevices).all()).toEqual([]);
  });
});

describe('GClients.reconcile: MTProxyL', () => {
  it('пользователь с секретом панели, ссылки в кэше, выключение и удаление', async () => {
    const c = mk('Олег');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const u = mt.s1?.users.get(c.slug);
    expect(u?.secret).toMatch(/^[0-9a-f]{32}$/);
    const b = db
      .select()
      .from(gclientBindings)
      .all()
      .find((x) => x.service === 'mtproxyl' && x.serverId === 's1');
    expect(b?.secret).toMatch(/^v1:/);
    expect(box.open(b?.secret ?? '')).toBe(u?.secret);
    expect(b?.links).toEqual([
      `https://t.me/proxy?server=1.2.3.4&port=443&secret=ee${u?.secret}`,
      `tg://proxy?server=1.2.3.4&port=443&secret=ee${u?.secret}`,
    ]);
    db.update(gclients).set({ enabled: false }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(mt.s1?.users.get(c.slug)?.enabled).toBe(false);
    db.update(gclients).set({ deletedAt: new Date().toISOString() }).run();
    await g.reconcile();
    expect(mt.s1?.users.size).toBe(0);
    expect(mt.s2?.users.size).toBe(0);
  });
});

describe('GClients.reconcile: WDTT', () => {
  it('пароль на человека: имя, лимит по устройствам без роутеров, вкл/выкл, заново, удаление', async () => {
    // WDTT есть только на s1
    db.update(servers)
      .set({
        statusCache: {
          inventory: { ...inventory, services: [{ kind: 'wdtt', title: 'WDTT', ports: [] }] },
        },
      } as never)
      .where(eq(servers.id, 's1'))
      .run();
    db.update(servers)
      .set({ statusCache: { inventory: { ...inventory, services: [] } } } as never)
      .where(eq(servers.id, 's2'))
      .run();
    const c = mk('Иван');
    for (const [id, type] of [
      ['d1', 'android'],
      ['d2', 'windows'],
      ['d3', 'router'],
    ] as const)
      db.insert(gclientDevices).values({ id, clientId: c.id, name: '', type }).run();
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const pw = () => [...(wd.s1?.passwords ?? [])];
    expect(pw()).toHaveLength(1);
    expect(pw()[0]?.[1]).toMatchObject({ label: 'Иван', max_devices: 2, is_deactivated: false });
    const wb = () =>
      db
        .select()
        .from(gclientBindings)
        .all()
        .filter((b) => b.service === 'wdtt');
    expect(wb()).toHaveLength(1);
    expect(wb()[0]).toMatchObject({ serverId: 's1', state: 'ok' });
    expect(box.open(wb()[0]?.secret ?? '')).toBe('pw1');
    expect(wb()[0]?.links[1]).toBe('wdtt://s1.example:56000:56001:9000:pw1:');

    // выключили клиента - пароль выключен
    db.update(gclients).set({ enabled: false }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(pw()[0]?.[1].is_deactivated).toBe(true);

    // пароль пропал на сервере - заводится заново, новый пароль в привязке
    db.update(gclients).set({ enabled: true }).run();
    wd.s1?.passwords.clear();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(pw().map(([k]) => k)).toEqual(['pw2']);
    expect(box.open(wb()[0]?.secret ?? '')).toBe('pw2');

    // удалили клиента - пароль удалён с сервера
    db.update(gclients).set({ deletedAt: new Date().toISOString() }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(pw()).toEqual([]);
    expect(wb()).toEqual([]);
  });
});

describe('GClients.reconcile: прокси для браузера', () => {
  it('пользователь на человека: пароль в базе, ссылка naive+https, выключение, удаление', async () => {
    // naive есть только на s1
    db.update(servers)
      .set({
        statusCache: {
          inventory: { ...inventory, services: [{ kind: 'naive', title: 'Браузер', ports: [] }] },
        },
      } as never)
      .where(eq(servers.id, 's1'))
      .run();
    db.update(servers)
      .set({ statusCache: { inventory: { ...inventory, services: [] } } } as never)
      .where(eq(servers.id, 's2'))
      .run();
    const c = mk('Иван');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const nb = () =>
      db
        .select()
        .from(gclientBindings)
        .all()
        .filter((b) => b.service === 'naive');
    expect(nb()).toHaveLength(1);
    expect(nb()[0]).toMatchObject({ serverId: 's1', state: 'ok', ref: c.slug });
    const pass = box.open(nb()[0]?.secret ?? '');
    expect(pass).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(nv.s1?.get(c.slug)).toBe(pass);
    expect(nv.s2?.size).toBe(0);
    expect(nb()[0]?.links[0]).toMatch(
      new RegExp(
        `^naive\\+https://${c.slug}:${pass}@s1\\.example\\.com:8444\\?probe=probe\\.test&p443=1#`,
      ),
    );

    // выключили - пользователя на сервере нет, пароль в базе тот же
    db.update(gclients).set({ enabled: false }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(nv.s1?.has(c.slug)).toBe(false);
    // включили - тот же пароль
    db.update(gclients).set({ enabled: true }).run();
    db.update(gclientBindings).set({ state: 'pending' }).run();
    await g.reconcile();
    expect(nv.s1?.get(c.slug)).toBe(pass);

    // доступ к сервису сняли - пользователь удалён, привязки нет
    db.update(gclients)
      .set({ access: [{ serverId: 's1', services: ['xui'] }] })
      .run();
    await g.reconcile();
    expect(nv.s1?.size).toBe(0);
    expect(nb()).toEqual([]);
  });
});

describe('GClients.reconcile: сервис пропал из снимка', () => {
  it('привязки остаются, пока сервиса нет меньше 30 минут, потом убираются', async () => {
    // часы стоят: привязка создана и правка сделана "в одну миллисекунду" - правка всё равно видна
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const c = mk('Пётр');
      const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
      await g.reconcile();
      const mtOn = () =>
        db
          .select()
          .from(gclientBindings)
          .all()
          .filter((b) => b.service === 'mtproxyl' && b.serverId === 's1');
      expect(mtOn()).toHaveLength(1);
      const secret = mtOn()[0]?.secret;

      // MTProxyL пропал из снимка s1 (перезапуск, переустановка): привязка и секрет на месте
      db.update(servers)
        .set({
          statusCache: {
            inventory: { ...inventory, services: inventory.services.slice(0, 2) },
          },
        } as never)
        .where(eq(servers.id, 's1'))
        .run();
      await g.reconcile();
      vi.setSystemTime(Date.now() + 20 * 60_000);
      await g.reconcile();
      expect(mtOn()).toHaveLength(1);
      expect(mtOn()[0]?.secret).toBe(secret);
      expect(mt.s1?.users.has(c.slug)).toBe(true);

      // нет дольше 30 минут - сервис удалён, привязки убираются; отсчёт пережил перезапуск
      // панели (новый GClients): он в базе, а не в памяти
      vi.setSystemTime(Date.now() + 15 * 60_000);
      const g2 = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
      await g2.reconcile();
      expect(mtOn()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('пустой список AWG без ответа docker - ключи не забываются', async () => {
    mk('Анна');
    db.insert(gclientDevices)
      .values({ id: 'dv', clientId: 'Анна', name: '', type: 'android' })
      .run();
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const awgB = () =>
      db
        .select()
        .from(gclientBindings)
        .all()
        .filter((b) => b.service === 'awg' && b.serverId === 's1');
    expect(awgB()).toHaveLength(1);
    // docker не ответил: агент отдал пустой список без docker: true
    const saved = registry.request;
    registry.request = (async (id: string, method: string, p: unknown) =>
      method === 'awg.status'
        ? { instances: [] }
        : (saved as (...a: unknown[]) => unknown)(id, method, p)) as typeof registry.request;
    try {
      db.update(gclientBindings).set({ state: 'pending' }).run();
      await g.reconcile();
      expect(awgB()).toHaveLength(1);
      expect(awgB()[0]?.state).toBe('error');
    } finally {
      registry.request = saved;
    }
  });
});

describe('GClients.reconcile: доступ клиента', () => {
  it('заводится только отмеченное; сузили - лишнее убирается с серверов; вернули - заводится снова', async () => {
    const c = mk('Оля');
    db.insert(gclientDevices)
      .values({ id: 'd1', clientId: c.id, name: 'телефон', type: 'android' })
      .run();
    db.update(gclients)
      .set({ access: [{ serverId: 's1', services: ['xui', 'awg'] }] })
      .where(eq(gclients.id, c.id))
      .run();
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    await g.reconcile();
    const pairs = () =>
      db
        .select()
        .from(gclientBindings)
        .all()
        .map((b) => `${b.serverId}:${b.service}`)
        .sort();
    // на s1 - VLESS и AWG, MTProxy нигде, на s2 - ничего
    expect(pairs()).toEqual(['s1:awg', 's1:xui']);
    expect(xui.s1?.clients.has(c.slug)).toBe(true);
    expect(xui.s2?.clients.has(c.slug)).toBe(false);
    expect(awg.s1?.instances[0]?.clients).toHaveLength(1);
    expect(mt.s1?.users.size).toBe(0);

    // сузили до MTProxy на s2: VLESS и пир AWG с s1 удаляются, на s2 заводится MTProxy
    db.update(gclients)
      .set({ access: [{ serverId: 's2', services: ['mtproxyl'] }] })
      .where(eq(gclients.id, c.id))
      .run();
    db.update(gclientBindings).set(queued()).run();
    await g.reconcile();
    expect(pairs()).toEqual(['s2:mtproxyl']);
    expect(xui.s1?.clients.has(c.slug)).toBe(false);
    expect(awg.s1?.instances[0]?.clients).toHaveLength(0);
    expect(mt.s2?.users.has(c.slug)).toBe(true);

    // вернули доступ ко всему: заводится на всех серверах
    db.update(gclients).set({ access: null }).where(eq(gclients.id, c.id)).run();
    await g.reconcile();
    expect(pairs()).toEqual(['s1:awg', 's1:mtproxyl', 's1:xui', 's2:awg', 's2:mtproxyl', 's2:xui']);
  });
});

describe('GClients.stop', () => {
  it('прерывает проход: необработанное остаётся в очереди, в журнале - "сверка прервана"', async () => {
    mk('Стоп');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    expect(g.stop()).toBe(false);
    g.kick();
    expect(g.stop()).toBe(true);
    for (let i = 0; i < 100 && g.syncing; i++) await new Promise((r) => setTimeout(r, 10));
    expect(g.syncing).toBe(false);
    expect(g.stopping).toBe(false);
    expect(
      db
        .select()
        .from(gclientBindings)
        .all()
        .some((b) => b.state === 'pending'),
    ).toBe(true);
    expect(journal.log.some((x) => /синхронизация прервана/.test(x.output))).toBe(true);
  });
});

describe('GClients.syncing', () => {
  it('идёт с запуска сверки до её конца - по нему ждёт кнопка "Сверить сейчас"', async () => {
    mk('Ира');
    const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
    expect(g.syncing).toBe(false);
    g.kick();
    expect(g.syncing).toBe(true);
    await vi.waitFor(() => expect(g.syncing).toBe(false), { timeout: 2000 });
  });
});

describe('GClients.reconcile: правка посреди прохода', () => {
  it('выключение клиента во время сверки не затирается, созданное на сервере не теряется', async () => {
    const c = mk('Гоша');
    const saved = registry.request;
    let raced = false;
    // админ выключает клиента, пока сверка заводит его секрет на s1 (как PATCH /api/gclients/:id)
    registry.request = (async (id: string, method: string, p: { op?: string }) => {
      const r = await (saved as (...a: unknown[]) => Promise<unknown>)(id, method, p);
      if (!raced && method === 'mtproxyl.exec' && p.op === 'secret.add') {
        raced = true;
        db.update(gclients).set({ enabled: false }).run();
        db.update(gclientBindings).set(queued()).where(eq(gclientBindings.clientId, c.id)).run();
      }
      return r;
    }) as typeof registry.request;
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
      g.kick();
      await vi.waitFor(() => expect(journal.log.length).toBeGreaterThanOrEqual(4), {
        timeout: 2000,
      });
      // второй проход после правки: клиент выключен на сервере, секрет тот же
      await vi.waitFor(() => expect(mt.s1?.users.get(c.slug)?.enabled).toBe(false), {
        timeout: 2000,
      });
      expect(mt.s1?.users.size).toBe(1);
      const b = db
        .select()
        .from(gclientBindings)
        .all()
        .find((x) => x.service === 'mtproxyl' && x.serverId === 's1');
      expect(box.open(b?.secret ?? '')).toBe(mt.s1?.users.get(c.slug)?.secret);
    } finally {
      vi.useRealTimers();
      registry.request = saved;
    }
  });
});

describe('GClients.reconcile: сервис или агент не отвечает', () => {
  it('ошибку состояния сервиса спрашивает один раз, при таймауте агента бросает сервер', async () => {
    mk('Вера');
    mk('Глеб');
    const saved = registry.request;
    let fail = 'mtproxyl: не запущен';
    let calls = 0;
    registry.request = (async (id: string, method: string, p: unknown) => {
      if (method === 'mtproxyl.status' && id === 's1') {
        calls++;
        throw new Error(fail);
      }
      return (saved as (...a: unknown[]) => Promise<unknown>)(id, method, p);
    }) as typeof registry.request;
    try {
      const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
      await g.reconcile();
      expect(calls).toBe(1);
      const s1 = journal.log.find((l) => l.serverId === 's1')?.output ?? '';
      expect(s1.match(/mtproxyl [a-z0-9-]+: ошибка: mtproxyl: не запущен/g)).toHaveLength(2);

      fail = 'агент не ответил вовремя';
      calls = 0;
      journal.log = [];
      db.update(gclientBindings).set(queued()).run();
      await g.reconcile();
      expect(calls).toBe(1);
      const out = journal.log.find((l) => l.serverId === 's1')?.output ?? '';
      expect(out).toContain('агент не отвечает - остальное в следующий раз');
      expect(out.match(/ошибка/g)).toHaveLength(1);
    } finally {
      registry.request = saved;
    }
  });
});

describe('GClients.reconcile: повтор ошибок', () => {
  it('ошибочная привязка повторяется не чаще раза в 30 минут, после правки - сразу', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      mk('Дина');
      const g = new GClients(db, box, registry, journal, async () => [], { warn: () => {} });
      await g.reconcile();
      const now = new Date().toISOString();
      db.update(gclientBindings).set({ state: 'error', error: 'x', updatedAt: now }).run();
      journal.log = [];
      await g.reconcile();
      expect(journal.log).toEqual([]);

      vi.setSystemTime(Date.now() + 31 * 60_000);
      await g.reconcile();
      expect(journal.log.length).toBeGreaterThan(0);

      db.update(gclientBindings).set({ state: 'error', updatedAt: new Date().toISOString() }).run();
      db.update(gclientBindings).set(queued()).run();
      journal.log = [];
      await g.reconcile();
      expect(journal.log.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
