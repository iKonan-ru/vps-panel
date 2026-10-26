import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerSummary } from '@vps/protocol';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { ACTION_OPS } from '../src/bot/actions.js';
import { CB_MAX, Refs, cb, parseCb } from '../src/bot/codec.js';
import { Bot, type BotTelegram, PRESS_OPS } from '../src/bot/index.js';
import { notifyButtons } from '../src/bot/notify-buttons.js';
import { SCREEN_OPS } from '../src/bot/screens.js';
import { BotStore } from '../src/bot/store.js';
import { clientView } from '../src/bot/views/clients.js';
import { plural, tail } from '../src/bot/views/common.js';
import { findServers, summaryView } from '../src/bot/views/menu.js';
import { problems, serversView } from '../src/bot/views/servers.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import { internalHeaders } from '../src/lib/internal-auth.js';
import { getSetting } from '../src/lib/settings.js';
import type { TgApiResult } from '../src/lib/telegram.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-bot-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
const db = createDb(':memory:');
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let registry: Awaited<ReturnType<typeof buildApp>>['registry'];
let hub: Awaited<ReturnType<typeof buildApp>>['hub'];

const calls: { method: string; params: Record<string, unknown> }[] = [];
const fake: BotTelegram = {
  api: async (method, params): Promise<TgApiResult> => {
    calls.push({ method, params });
    if (method === 'getMe') return { ok: true, result: { username: 'test_bot' }, via: 'direct' };
    if (method === 'sendMessage') return { ok: true, result: { message_id: 500 }, via: 'direct' };
    return { ok: true, result: true, via: 'direct' };
  },
  settings: async () => ({ token: '1:x' }) as Awaited<ReturnType<BotTelegram['settings']>>,
  health: () => ({
    ok: true,
    failingSince: null,
    lastOkAt: null,
    lastOkVia: null,
    lastError: null,
    checkedAt: null,
    pending: 0,
  }),
  chatsFromBot: null,
  buttons: null,
  muteUntil: () => undefined,
  sendDocument: async () => null,
  sendFile: async () => ({ err: null, messageId: 77 }),
};
let bot: Bot;

const ADMIN = 155;
const STRANGER = 999;
const msg = (from: number, text: string, type = 'private') => ({
  update_id: 1,
  message: {
    message_id: 10,
    date: Math.floor(Date.now() / 1000),
    chat: { id: from, type },
    from: { id: from, first_name: 'Анна', username: 'anna' },
    text,
  },
});
const press = (from: number, data: string) => ({
  update_id: 2,
  callback_query: {
    id: 'q1',
    from: { id: from },
    data,
    message: { message_id: 11, date: 0, chat: { id: from, type: 'private' } },
  },
});
const sent = (method: string) => calls.filter((c) => c.method === method);

beforeAll(async () => {
  ({ app, registry, hub } = await buildApp({ env, db }));
  await app.ready();
  db.insert(servers)
    .values([
      { id: 'srv-hoster-000000000001', name: 'Hoster', host: '203.0.113.10', tags: ['shared'] },
      { id: 'srv-netcore-00000000002', name: 'NetCore', host: '198.51.100.7' },
    ])
    .run();
  bot = new Bot({
    db,
    telegram: fake,
    inject: (o) => app.inject(o),
    panelUrl: 'https://panel.example.com',
    version: '9.9.9',
    log: { info: () => undefined, warn: () => undefined },
    hub,
  });
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
});

describe('bot binding and access', () => {
  it('ignores everyone before binding', async () => {
    await bot.handle(msg(ADMIN, '/menu'));
    expect(calls).toEqual([]);
  });

  it('binds the account by the one-time link code', async () => {
    const link = await bot.link();
    expect(link.url).toMatch(/^https:\/\/t\.me\/test_bot\?start=[A-Za-z0-9_-]{16}$/);
    expect(getSetting(db, 'tg_bot_on')).toBe('1');
    const code = link.url.split('start=')[1] ?? '';
    calls.length = 0;
    // чужой с неверным кодом - тишина
    await bot.handle(msg(STRANGER, '/start wrongcodewrongcode'));
    expect(calls).toEqual([]);
    await bot.handle(msg(ADMIN, `/start ${code}`));
    expect(bot.admin()?.id).toBe(String(ADMIN));
    expect(sent('setMyCommands')[0]?.params.scope).toEqual({
      type: 'chat',
      chat_id: String(ADMIN),
    });
    const texts = sent('sendMessage').map((c) => String(c.params.text));
    expect(texts[0]).toContain('привязан');
    expect(texts[1]).toContain('VPS Panel 9.9.9');
    const rows = db.select().from(actionLog).all();
    expect(rows.some((r) => r.kind === 'bot.bind')).toBe(true);
  });

  it('the code works only once', async () => {
    const link = await bot.link();
    const code = link.url.split('start=')[1] ?? '';
    await bot.handle(msg(STRANGER, `/start ${code}`));
    expect(bot.admin()?.id).toBe(String(STRANGER));
    await bot.handle(msg(ADMIN, `/start ${code}`));
    expect(bot.admin()?.id).toBe(String(STRANGER));
    // вернуть администратора
    const again = await bot.link();
    await bot.handle(msg(ADMIN, `/start ${again.url.split('start=')[1]}`));
    expect(bot.admin()?.id).toBe(String(ADMIN));
  });

  it('answers the admin only in the private chat', async () => {
    await bot.handle(msg(ADMIN, '/menu', 'group'));
    expect(sent('sendMessage')).toEqual([]);
    await bot.handle(msg(STRANGER, '/menu'));
    expect(sent('sendMessage')).toEqual([]);
    await bot.handle(press(STRANGER, cb('sv', 'srv-hoster-000000000001')));
    expect(sent('editMessageText')).toEqual([]);
    expect(sent('answerCallbackQuery')).toHaveLength(1);
  });
});

describe('bot screens', () => {
  it('menu buttons and search', async () => {
    await bot.handle(msg(ADMIN, 'Серверы'));
    expect(String(sent('sendMessage')[0]?.params.text)).toContain('<b>Hoster</b>');
    calls.length = 0;
    await bot.handle(msg(ADMIN, 'netc'));
    expect(String(sent('sendMessage')[0]?.params.text)).toContain('<b>NetCore</b>');
  });

  it('server card with a panel link and back button', async () => {
    await bot.handle(press(ADMIN, cb('sv', 'srv-hoster-000000000001')));
    const e = sent('editMessageText')[0]?.params;
    expect(String(e?.text)).toContain('203.0.113.10');
    const kb = (e?.reply_markup as { inline_keyboard: { text: string; url?: string }[][] })
      .inline_keyboard;
    expect(
      kb.flat().some((b) => b.url === 'https://panel.example.com/servers/srv-hoster-000000000001'),
    ).toBe(true);
  });

  it('a deleted server falls back to the list', async () => {
    await bot.handle(press(ADMIN, cb('sv', 'gone')));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('<b>Серверы</b>');
    expect(sent('answerCallbackQuery')[0]?.params.text).toBeTruthy();
  });

  it('stale tag reference reopens the summary', async () => {
    await bot.handle(press(ADMIN, cb('sl', 'nosuchref', 0)));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('VPS Panel');
  });

  it('journal lists actions', async () => {
    await bot.handle(press(ADMIN, cb('lg', '-', 0)));
    const e = sent('editMessageText')[0]?.params;
    const kb = (
      e?.reply_markup as { inline_keyboard: { text: string; callback_data?: string }[][] }
    ).inline_keyboard;
    expect(kb.flat().some((b) => b.text.includes('привязка'))).toBe(true);
  });

  it('turning off from the bot removes the keyboard and stops answering', async () => {
    await bot.handle(press(ADMIN, cb('off!')));
    expect(getSetting(db, 'tg_bot_on')).toBe('0');
    const m = sent('sendMessage')[0]?.params;
    expect(m?.reply_markup).toEqual({ remove_keyboard: true });
  });

  it('unbind forgets the account', async () => {
    await bot.unbind();
    expect(bot.admin()).toBeNull();
    calls.length = 0;
    await bot.handle(msg(ADMIN, '/menu'));
    expect(calls).toEqual([]);
  });
});

describe('internal requests', () => {
  it('only the process key opens the API', async () => {
    const bad = await app.inject({
      method: 'GET',
      url: '/api/servers',
      headers: { 'x-vps-internal': 'a'.repeat(64) },
    });
    expect(bad.statusCode).toBe(401);
    const ok = await app.inject({ method: 'GET', url: '/api/servers', headers: internalHeaders() });
    expect(ok.statusCode).toBe(200);
  });
});

describe('bot codec and views', () => {
  it('callback data stays within 64 bytes', () => {
    expect(() => cb('sv', 'x'.repeat(70))).toThrow();
    expect(Buffer.byteLength(cb('ac', 'x'.repeat(22), 's'))).toBeLessThanOrEqual(CB_MAX);
    expect(parseCb('lg:abc:2')).toEqual({ op: 'lg', args: ['abc', '2'] });
  });

  it('client card: personal page as a link button when it is https', () => {
    const d = (page: string) =>
      ({
        client: { id: 'c1', name: 'Анна', enabled: true, access: null, note: '' },
        syncing: false,
        subscription: { url: `${page}/sub/t`, page: `${page}/c/t`, temporary: false },
        devices: [],
        bindings: [],
      }) as never;
    const ctx = { now: Date.now(), panelUrl: 'https://panel.example.com', ref: (v: string) => v };
    const https = JSON.stringify(clientView(d('https://sub.example.com'), [], ctx).kb);
    expect(https).toContain('"url":"https://sub.example.com/c/t"');
    expect(https).not.toContain('gk:c1');
    expect(JSON.stringify(clientView(d('http://203.0.113.5'), [], ctx).kb)).toContain('gk:c1');
  });

  it('refs keep values and reuse keys', () => {
    const r = new Refs();
    const k = r.put('Резерв');
    expect(r.put('Резерв')).toBe(k);
    expect(r.get(k)).toBe('Резерв');
    expect(r.get('nope')).toBeNull();
  });

  const base = {
    sshPort: 22,
    tags: [],
    lastSeenAt: null,
    agentVersion: '1',
    agentUpdateAvailable: false,
    agentUpdating: false,
    hosting: {
      provider: '',
      providerServerName: '',
      providerUrl: '',
      country: '',
      price: null,
      currency: 'RUB',
      billingMonths: 1,
      nextPaymentAt: null,
      notes: '',
    },
    metrics: null,
    services: [],
    audit: null,
    firewall: null,
    dockerVersion: null,
    panelHost: false,
    panelLinks: {},
  } satisfies Omit<ServerSummary, 'id' | 'name' | 'host' | 'status'>;
  const now = Date.parse('2026-10-23T12:00:00Z');
  const ctx = { now, panelUrl: '', ref: (v: string) => v };

  it('problems: offline hides the rest, a down service is bad', () => {
    const off: ServerSummary = {
      ...base,
      id: 'a',
      name: 'A',
      host: '203.0.113.1',
      status: 'offline',
      lastSeenAt: '2026-10-23T11:46:00Z',
      services: [{ kind: 'xui', title: '3X-UI', ports: [], details: { down: true } }],
    };
    expect(problems(off, null, now)).toEqual([{ bad: true, text: 'не в сети 14\u00a0мин' }]);
    const down: ServerSummary = { ...off, status: 'online' };
    expect(problems(down, null, now)).toEqual([{ bad: true, text: '3X-UI не работает' }]);
  });

  it('summary lists problems and payment soon', () => {
    const list: ServerSummary[] = [
      { ...base, id: 'a', name: 'Hoster', host: 'h', status: 'online' },
      {
        ...base,
        id: 'b',
        name: 'Web<io>',
        host: 'w',
        status: 'offline',
        hosting: { ...base.hosting, nextPaymentAt: '2026-10-24T00:00:00.000Z', price: 450 },
      },
    ];
    const s = summaryView(
      {
        version: '1.0.0',
        newer: null,
        servers: list,
        reach: {},
        updates: {},
        clients: [],
        running: [],
      },
      ctx,
    );
    expect(s.text).toContain('1 в сети, 1 не в сети');
    expect(s.text).toContain('Web&lt;io&gt;');
    expect(s.text).toContain('Оплата: Web&lt;io&gt; завтра, 450\u00a0RUB');
    expect(s.kb[0]?.[0]?.data).toBe('sv:b');
  });

  it('server list pages and filters by tag without case', () => {
    const list: ServerSummary[] = Array.from({ length: 10 }, (_, i) => ({
      ...base,
      id: `s${i}`,
      name: `S${i}`,
      host: 'h',
      status: 'online' as const,
      tags: i % 2 ? ['Резерв'] : [],
    }));
    const p1 = serversView({ servers: list, reach: {}, tags: [] }, { tag: null, page: 1 }, ctx);
    expect(p1.text).toContain('S8');
    expect(p1.text).not.toContain('S0');
    const t = serversView(
      { servers: list, reach: {}, tags: [{ name: 'Резерв', color: 'sky', servers: 5 }] },
      { tag: 'резерв', page: 0 },
      ctx,
    );
    expect(t.text).toContain('\u00b7 5');
  });

  it('search, plural, output tail', () => {
    const list = [
      { ...base, id: 'a', name: 'SkyHost Public', host: '203.0.113.5', status: 'online' as const },
      { ...base, id: 'b', name: 'SkyHost', host: '203.0.113.6', status: 'online' as const },
    ];
    expect(findServers(list, 'skyhost').map((s) => s.id)).toEqual(['b']);
    expect(findServers(list, '113.5').map((s) => s.id)).toEqual(['a']);
    expect(plural(1, 'сервере', 'серверах', 'серверах')).toBe('сервере');
    expect(plural(11, 'сервере', 'серверах', 'серверах')).toBe('серверах');
    expect(tail('a\nb\nc', 3)).toBe('c');
  });
});

describe('notification buttons', () => {
  it('actions by level, navigation always', () => {
    const all = notifyButtons(
      { event: 'serviceDown', serverId: 'abc', data: { kind: 'xui', title: '3X-UI' } },
      'all',
      (v) => v,
    );
    expect(all.flat().map((b) => b.data)).toEqual(['rs:abc:x', 'o:sv:abc']);
    const view = notifyButtons(
      { event: 'serviceDown', serverId: 'abc', data: { kind: 'xui', title: '3X-UI' } },
      'view',
      (v) => v,
    );
    expect(view.flat().map((b) => b.data)).toEqual(['o:sv:abc']);
    const off = notifyButtons(
      { event: 'offline', serverId: 'abc', providerUrl: 'https://hoster.example.com/vm/1' },
      'all',
      (v) => v,
    );
    expect(off.flat().map((b) => b.url ?? b.data)).toEqual([
      'o:sv:abc',
      'https://hoster.example.com/vm/1',
      'mu:abc',
    ]);
    expect(notifyButtons({ event: 'auditClosed', serverId: 'abc' }, 'all', (v) => v)).toEqual([]);
  });
});

describe('bot actions', () => {
  const SID = 'srv-actions-000000000003';
  let secret = '';

  beforeAll(async () => {
    const { initAdmin, saveTotp } = await import('../src/lib/auth.js');
    const { authenticator: a } = await import('otplib');
    await initAdmin(db, 'admin');
    const adminRow = await (await import('../src/lib/auth.js')).theAdmin(db);
    secret = a.generateSecret();
    await saveTotp(db, adminRow?.id ?? '', secret, []);
    db.insert(servers)
      .values({
        id: SID,
        name: 'Kappa',
        host: '203.0.113.30',
        agentTokenHash: 'x',
        statusCache: {
          inventory: {
            host: { hostname: 'k', os: 'u', kernel: 'k', arch: 'amd64', agentVersion: '1' },
            services: [{ kind: 'xui', title: '3X-UI', ports: [], details: { down: false } }],
            containers: [],
            certs: [],
            unchecked: [],
            collectedAt: new Date().toISOString(),
            firewall: {
              ufwActive: true,
              defaultIncoming: 'deny',
              portsyncInstalled: false,
              portsyncActive: false,
              dockerFiltered: true,
              rules: [],
              listeners: [],
            },
            audit: {
              sshPort: 22,
              sshPasswordAuth: false,
              sshPermitRootLogin: 'no',
              fail2banRunning: true,
              fail2banJails: ['sshd'],
              jails: [
                { name: 'sshd', banned: 1, totalBanned: 5, failed: 0, bannedIps: ['192.0.2.9'] },
              ],
              unattendedUpgrades: true,
              pendingUpdates: 3,
              rebootRequired: false,
              findings: [],
            },
          },
        },
      })
      .run();
    // сервер "в сети" для проверок маршрутов; запрос к агенту всё равно не пройдёт
    const online = registry.isOnline.bind(registry);
    registry.isOnline = (id: string) => id === SID || online(id);
    // аккаунт снова привязан, управление включено
    const link = await bot.link();
    await bot.handle(msg(ADMIN, `/start ${link.url.split('start=')[1]}`));
  });

  const notif = (data: string) => ({
    update_id: 3,
    callback_query: {
      id: 'q2',
      from: { id: ADMIN },
      data,
      message: {
        message_id: 50,
        date: 0,
        chat: { id: ADMIN, type: 'private' },
        reply_markup: { inline_keyboard: [[{ text: 'x', callback_data: data }]] },
      },
    },
  });

  it('notification buttons only while management is on', async () => {
    const markup = await fake.buttons?.({ event: 'bans', serverId: SID });
    expect(JSON.stringify(markup)).toContain(`o:bn:${SID}`);
  });

  it('a service that already works: alert and the button goes away', async () => {
    await bot.handle(notif(cb('rs', SID, 'x')));
    expect(sent('answerCallbackQuery')[0]?.params.text).toBe('3X-UI уже работает');
    expect(sent('editMessageReplyMarkup')[0]?.params.reply_markup).toEqual({ inline_keyboard: [] });
  });

  it('unban runs at once and is logged as started from Telegram', async () => {
    await bot.handle(press(ADMIN, cb('o', 'bn', SID)));
    const kb = (
      sent('editMessageText')[0]?.params.reply_markup as {
        inline_keyboard: { text: string; callback_data?: string }[][];
      }
    ).inline_keyboard;
    const unban = kb.flat().find((b) => b.text.includes('192.0.2.9'))?.callback_data ?? '';
    calls.length = 0;
    await bot.handle(notif(unban));
    const row = db
      .select()
      .from(actionLog)
      .all()
      .find((r) => r.kind === 'fail2ban.unban');
    expect(row?.initiator).toBe('telegram');
    // агента нет: ошибка - всплывающим сообщением, новых сообщений нет
    expect(sent('answerCallbackQuery').at(-1)?.params.show_alert).toBe(true);
    expect(sent('sendMessage')).toEqual([]);
  });

  it('dangerous action: confirmation only, no 2FA code', async () => {
    await bot.handle(notif(cb('pu', SID)));
    // подтверждение - на месте уведомления
    expect(sent('sendMessage')).toEqual([]);
    const confirm = sent('editMessageText')[0]?.params;
    expect(confirm?.message_id).toBe(50);
    expect(String(confirm?.text)).toContain('Обновить пакеты на Kappa?');
    const ok =
      (confirm?.reply_markup as { inline_keyboard: { callback_data?: string }[][] })
        .inline_keyboard[0]?.[0]?.callback_data ?? '';
    calls.length = 0;
    await bot.handle(press(ADMIN, ok));
    // действие запущено сразу (ход - в том же сообщении), агента нет - итог с ошибкой
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('обновление пакетов');
    expect(String(sent('editMessageText')[0]?.params.text)).not.toContain('Код двухфакторной');
    await vi.waitFor(
      () => {
        const last = sent('editMessageText').at(-1)?.params;
        expect(String(last?.text)).toContain('\u274c');
        expect(String(last?.text)).not.toContain('<pre>');
        expect(JSON.stringify(last?.reply_markup)).toContain('Вывод файлом');
      },
      { timeout: 5000 },
    );
    const row = db
      .select()
      .from(actionLog)
      .all()
      .find((r) => r.kind === 'system.upgrade');
    expect(row?.initiator).toBe('telegram');
  });

  it('removing a server: confirmation, then the 2FA code, wrong code counts', async () => {
    const { authenticator: a } = await import('otplib');
    const RID = 'srv-remove-00000000004';
    db.insert(servers).values({ id: RID, name: 'Orbit', host: '203.0.113.44' }).run();
    await bot.handle(press(ADMIN, cb('sv', RID)));
    expect(JSON.stringify(sent('editMessageText')[0]?.params.reply_markup)).toContain(`rm:${RID}`);
    calls.length = 0;
    await bot.handle(notif(cb('rm', RID)));
    const confirm = sent('editMessageText')[0]?.params;
    expect(String(confirm?.text)).toContain('Удалить Orbit из панели?');
    const ok =
      (confirm?.reply_markup as { inline_keyboard: { callback_data?: string }[][] })
        .inline_keyboard[0]?.[0]?.callback_data ?? '';
    calls.length = 0;
    await bot.handle(press(ADMIN, ok));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('Код двухфакторной');
    calls.length = 0;
    await bot.handle(msg(ADMIN, '000000'));
    expect(sent('deleteMessage')).toHaveLength(1);
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('попыток: 4');
    expect(
      db
        .select()
        .from(servers)
        .all()
        .some((r) => r.id === RID),
    ).toBe(true);
    calls.length = 0;
    await bot.handle(msg(ADMIN, a.generate(secret)));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('удалён из панели');
    expect(
      db
        .select()
        .from(servers)
        .all()
        .some((r) => r.id === RID),
    ).toBe(false);
  });

  it('maintenance and security screens from the server card', async () => {
    await bot.handle(press(ADMIN, cb('sv', SID)));
    const card = JSON.stringify(sent('editMessageText')[0]?.params.reply_markup);
    expect(card).toContain(`mt:${SID}`);
    expect(card).toContain(`sc:${SID}`);
    expect(card).not.toContain(`dk:${SID}`);
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('mt', SID)));
    const mt = sent('editMessageText')[0]?.params;
    expect(String(mt?.text)).toContain('Обновления безопасности: 3');
    expect(JSON.stringify(mt?.reply_markup)).toContain(`cl:${SID}`);
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('sc', SID)));
    expect(JSON.stringify(sent('editMessageText')[0]?.params.reply_markup)).toContain(`fd:${SID}`);
  });

  it('cleanup without the agent: an error alert, nothing runs', async () => {
    await bot.handle(press(ADMIN, cb('cl', SID)));
    expect(sent('answerCallbackQuery')[0]?.params.show_alert).toBe(true);
    expect(sent('sendMessage')).toEqual([]);
  });

  it('clients: wizard creates a client with a device', async () => {
    await bot.handle(press(ADMIN, cb('nc')));
    const ask = sent('editMessageText')[0]?.params;
    expect(String(ask?.text)).toContain('Имя клиента');
    calls.length = 0;
    await bot.handle(msg(ADMIN, 'Борис'));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('Тип устройства');
    const flowMsg = { message_id: 11, date: 0, chat: { id: ADMIN, type: 'private' } };
    calls.length = 0;
    await bot.handle({
      update_id: 5,
      callback_query: { id: 'q', from: { id: ADMIN }, data: cb('fy', 'android'), message: flowMsg },
    });
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('Имя устройства');
    calls.length = 0;
    await bot.handle(msg(ADMIN, 'pixel'));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('создан');
    const list = (
      await app.inject({ method: 'GET', url: '/api/gclients', headers: internalHeaders() })
    ).json() as {
      name: string;
      devices: { name: string; type: string }[];
    }[];
    const b = list.find((c) => c.name === 'Борис');
    expect(b?.devices).toEqual([expect.objectContaining({ name: 'pixel', type: 'android' })]);
  });

  it('clients: card, links with copy buttons and later removal', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/gclients', headers: internalHeaders() })
    ).json() as {
      id: string;
      name: string;
    }[];
    const id = list.find((c) => c.name === 'Борис')?.id ?? '';
    await bot.handle(msg(ADMIN, 'Клиенты'));
    expect(String(sent('sendMessage')[0]?.params.text)).toContain('<b>Борис</b>');
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('gc', id)));
    expect(JSON.stringify(sent('editMessageText')[0]?.params.reply_markup)).toContain(`gk:${id}`);
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('gk', id)));
    const links = sent('sendMessage')[0]?.params;
    expect(String(links?.text)).toContain('tg-spoiler');
    expect(JSON.stringify(links?.reply_markup)).toContain('copy_text');
    expect(getSetting(db, 'tg_bot_delete')).toContain('"chat":"155"');
  });

  it('clients: turning off needs confirmation', async () => {
    const list = (
      await app.inject({ method: 'GET', url: '/api/gclients', headers: internalHeaders() })
    ).json() as {
      id: string;
      name: string;
      enabled: boolean;
    }[];
    const id = list.find((c) => c.name === 'Борис')?.id ?? '';
    await bot.handle(press(ADMIN, cb('ge', id, 0)));
    const confirm = sent('editMessageText')[0]?.params;
    expect(String(confirm?.text)).toContain('Выключить клиента Борис?');
    const ok =
      (confirm?.reply_markup as { inline_keyboard: { callback_data?: string }[][] })
        .inline_keyboard[0]?.[0]?.callback_data ?? '';
    await bot.handle(press(ADMIN, ok));
    const after = (
      await app.inject({ method: 'GET', url: '/api/gclients', headers: internalHeaders() })
    ).json() as {
      name: string;
      enabled: boolean;
    }[];
    expect(after.find((c) => c.name === 'Борис')?.enabled).toBe(false);
  });

  it('service screens: 3X-UI with forced restart, services in the card', async () => {
    await bot.handle(press(ADMIN, cb('sv', SID)));
    expect(JSON.stringify(sent('editMessageText')[0]?.params.reply_markup)).toContain(`xu:${SID}`);
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('xu', SID)));
    const e = sent('editMessageText')[0]?.params;
    expect(String(e?.text)).toContain('3X-UI');
    expect(JSON.stringify(e?.reply_markup)).toContain(`rs:${SID}:x:f`);
    expect(JSON.stringify(e?.reply_markup)).toContain(`cs:${SID}`);
  });

  it('settings: version, notifications toggles, sessions', async () => {
    await bot.handle(msg(ADMIN, 'Ещё'));
    const st = JSON.stringify(sent('sendMessage')[0]?.params.reply_markup);
    expect(st).toContain('"vs"');
    expect(st).toContain('"ns"');
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('ns')));
    const ns = sent('editMessageText')[0]?.params;
    expect(String(ns?.text)).toContain('Заканчивается место на диске');
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('ss')));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('Сессии панели');
    calls.length = 0;
    await bot.handle(press(ADMIN, cb('vs')));
    expect(String(sent('editMessageText')[0]?.params.text)).toContain('Версия панели');
  });

  it('one message: cancel restores the notification, navigation returns to it', async () => {
    const n = {
      update_id: 7,
      callback_query: {
        id: 'q7',
        from: { id: ADMIN },
        data: cb('pu', SID),
        message: {
          message_id: 70,
          date: 0,
          chat: { id: ADMIN, type: 'private' },
          text: 'Kappa: обновления',
          entities: [{ type: 'bold', offset: 0, length: 5 }],
          reply_markup: {
            inline_keyboard: [[{ text: 'Обновить пакеты', callback_data: cb('pu', SID) }]],
          },
        },
      },
    };
    await bot.handle(n);
    const confirm = sent('editMessageText')[0]?.params;
    const kb = (confirm?.reply_markup as { inline_keyboard: { callback_data?: string }[][] })
      .inline_keyboard;
    const cancel = kb[0]?.[1]?.callback_data ?? '';
    calls.length = 0;
    await bot.handle({ ...n, callback_query: { ...n.callback_query, data: cancel } });
    const back = sent('editMessageText')[0]?.params;
    expect(back?.message_id).toBe(70);
    expect(back?.text).toBe('Kappa: обновления');
    expect(back?.entities).toEqual([{ type: 'bold', offset: 0, length: 5 }]);
    calls.length = 0;
    // переход из уведомления - на месте, с возвратом
    await bot.handle({ ...n, callback_query: { ...n.callback_query, data: cb('o', 'sv', SID) } });
    const card = sent('editMessageText')[0]?.params;
    expect(card?.message_id).toBe(70);
    expect(JSON.stringify(card?.reply_markup)).toContain('"ob"');
    calls.length = 0;
    await bot.handle({ ...n, callback_query: { ...n.callback_query, data: 'ob' } });
    expect(sent('editMessageText')[0]?.params.text).toBe('Kappa: обновления');
  });

  it('menu keeps one home screen: previous one and the typed message are deleted', async () => {
    await bot.handle(msg(ADMIN, 'Серверы'));
    calls.length = 0;
    await bot.handle(msg(ADMIN, 'Клиенты'));
    const del = sent('deleteMessage').map((c) => c.params.message_id);
    expect(del).toContain(10);
    expect(del).toContain(500);
    expect(sent('sendMessage')).toHaveLength(1);
  });

  it('a switch on the home screen does not keep it from being replaced', async () => {
    await bot.handle(msg(ADMIN, 'Ещё'));
    await bot.handle({
      update_id: 8,
      callback_query: {
        id: 'q8',
        from: { id: ADMIN },
        data: cb('nt', 0, 1),
        message: { message_id: 500, date: 0, chat: { id: ADMIN, type: 'private' } },
      },
    });
    calls.length = 0;
    await bot.handle(msg(ADMIN, 'Клиенты'));
    expect(sent('deleteMessage').map((c) => c.params.message_id)).toContain(500);
  });

  it('view level refuses actions', async () => {
    bot.setLevel('view');
    await bot.handle(notif(cb('pu', SID)));
    expect(sent('answerCallbackQuery')[0]?.params.show_alert).toBe(true);
    expect(sent('sendMessage')).toEqual([]);
    bot.setLevel('all');
  });
});

describe('bot registries and state across restarts', () => {
  const SID = 'srv-actions-000000000003';

  it('button codes of actions, screens and service buttons do not overlap', () => {
    const all = [...ACTION_OPS, ...SCREEN_OPS, ...PRESS_OPS];
    expect(new Set(all).size).toBe(all.length);
    expect(ACTION_OPS.has('rm')).toBe(true);
    expect(SCREEN_OPS.has('sv')).toBe(true);
  });

  it('expired state is not read and goes away', () => {
    let now = 1_000;
    const s = new BotStore(db, () => now);
    s.put('test', 'k', { v: 1 }, 100);
    expect(s.get('test', 'k')).toEqual({ v: 1 });
    now = 2_000;
    expect(s.get('test', 'k')).toBeNull();
    s.prune();
    expect(s.list('test')).toEqual([]);
  });

  it('short refs survive a restart and keep one key per value', () => {
    const k = new Refs(new BotStore(db)).put('Резерв');
    const again = new Refs(new BotStore(db));
    expect(again.get(k)).toBe('Резерв');
    expect(again.put('Резерв')).toBe(k);
  });

  it('after a restart: back to the notification and the result of an action started before', async () => {
    const n = {
      update_id: 9,
      callback_query: {
        id: 'q9',
        from: { id: ADMIN },
        data: cb('o', 'sv', SID),
        message: {
          message_id: 90,
          date: 0,
          chat: { id: ADMIN, type: 'private' },
          text: 'Kappa: не в сети',
          reply_markup: {
            inline_keyboard: [[{ text: 'Сервер', callback_data: cb('o', 'sv', SID) }]],
          },
        },
      },
    };
    await bot.handle(n);
    // действие, запущенное из бота до перезапуска и прерванное им
    const id = 'act-restart-000000001';
    db.insert(actionLog)
      .values({
        id,
        serverId: SID,
        kind: 'system.upgrade',
        params: {},
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        output: 'apt\nПанель перезапущена, действие прервано\n',
        initiator: 'telegram',
      })
      .run();
    new BotStore(db).put(
      'track',
      id,
      {
        chat: ADMIN,
        mid: 91,
        header: '<b>Kappa</b>: обновление пакетов',
        startedAt: Date.now(),
        done: null,
        op: 'pu',
        args: [SID],
      },
      60_000,
    );
    // новая панель: другой экземпляр бота на той же базе
    const after = new Bot({
      db,
      telegram: fake,
      inject: (o) => app.inject(o),
      panelUrl: 'https://panel.example.com',
      version: '9.9.9',
      log: { info: () => undefined, warn: () => undefined },
      hub,
    });
    // запуск без токена: приём сообщений ждёт, действия после перезапуска - досматриваются
    const settings = fake.settings;
    fake.settings = async () => ({ token: '' }) as Awaited<ReturnType<BotTelegram['settings']>>;
    const stop = after.start();
    calls.length = 0;
    await after.handle({ ...n, callback_query: { ...n.callback_query, data: 'ob' } });
    expect(sent('editMessageText')[0]?.params.text).toBe('Kappa: не в сети');
    await vi.waitFor(() => {
      const e = sent('editMessageText').find((c) => c.params.message_id === 91)?.params;
      expect(String(e?.text)).toContain('действие прервано');
      expect(JSON.stringify(e?.reply_markup)).toContain(`af:${id}`);
    });
    stop();
    fake.settings = settings;
  });
});
