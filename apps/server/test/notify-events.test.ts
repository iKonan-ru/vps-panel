import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNotifyEvents } from '@vps/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import { Notifier, reachEvent } from '../src/lib/notify.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { getSetting, putSetting } from '../src/lib/settings.js';
import { Telegram } from '../src/lib/telegram.js';

async function make() {
  const db = createDb(':memory:');
  const tg = new Telegram(db, new SecretBox('x'.repeat(32)), {} as never, {
    info: () => undefined,
    warn: () => undefined,
  });
  await tg.save({ token: '1:t', chatId: '42' });
  const sent: string[] = [];
  tg.send = async (m: string) => {
    sent.push(m);
    return null;
  };
  const refreshes: unknown[][] = [];
  const reg = Object.assign(new EventEmitter(), {
    isOnline: () => false,
    isUpdating: () => false,
    refreshInventory: async (...a: unknown[]) => void refreshes.push(a),
  });
  const n = new Notifier(db, reg as never, tg);
  return { db, tg, sent, reg, n, refreshes };
}

const inv = (down: boolean) =>
  ({
    services: [
      {
        kind: 'wdtt',
        title: 'WDTT',
        ports: [],
        details: down ? { down: true, downReason: 'служба wdtt: failed' } : {},
      },
    ],
  }) as never;

afterEach(() => {
  vi.useRealTimers();
});

describe('события уведомлений', () => {
  it('прежние группы событий раскладывает шаг базы, новые ключи важнее', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-ev-'));
    const db = createDb(dir);
    putSetting(
      db,
      'tg_events',
      JSON.stringify({ offline: false, audit: true, updates: false, payment: true }),
    );
    const raw = new Database(join(dir, 'panel.db'));
    raw.pragma('user_version = 20');
    raw.close();
    const again = createDb(dir);
    const saved = JSON.parse(getSetting(again, 'tg_events') ?? '{}') as Record<string, unknown>;
    expect(saved.audit).toBeUndefined();
    expect(readNotifyEvents(saved)).toMatchObject({
      offline: false,
      online: false,
      auditNew: true,
      pkgUpdates: false,
      updXray: false,
      payment: true,
      serviceDown: true,
    });
  });

  it('wants: выключенное событие и отключённый сервер', async () => {
    const { tg } = await make();
    await tg.save({
      events: { ...(await tg.settings()).events, bans: false },
      mutedServers: ['s2'],
    });
    expect(await tg.wants('bans', 's1')).toBe(false);
    expect(await tg.wants('auditNew', 's1')).toBe(true);
    expect(await tg.wants('auditNew', 's2')).toBe(false);
    expect(await tg.wants('payment')).toBe(true);
  });

  it('цель доступности -> событие', () => {
    expect(reachEvent('ip', false)).toBe('reachAddr');
    expect(reachEvent('xui:3', false)).toBe('reachInbound');
    expect(reachEvent('mtproxyl', false)).toBe('reachMtproxy');
    expect(reachEvent('xui:3', true)).toBe('reachBack');
  });

  it('сервис упал (дольше 2 минут) и снова работает', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const ctx = await make();
    const stop = ctx.n.bind([]);
    const on = (i: unknown) => ctx.reg.emit('inventory', 's1', i);
    const flush = () => new Promise((r) => setTimeout(r, 20));

    vi.setSystemTime(new Date('2026-10-12T10:05:00Z')); // после тихого старта
    on(inv(false)); // первый снимок - только запомнить
    await flush();
    on(inv(true)); // упал: ещё ждём
    await flush();
    expect(ctx.sent).toEqual([]);
    vi.setSystemTime(new Date('2026-10-12T10:08:00Z'));
    on(inv(true));
    await flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatch(/WDTT не работает: служба wdtt: failed/);
    on(inv(false));
    await flush();
    expect(ctx.sent[1]).toMatch(/WDTT снова работает/);
    stop();
  });

  it('критичные замечания: одно сообщение, устранение - правкой его же', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const ctx = await make();
    let mid = 0;
    const tg = ctx.tg as unknown as {
      send: (m: string, o?: { meta?: { ref?: string } }) => Promise<null>;
      remember: (ref: string, v: { chat: string; id: number; at: string }) => void;
      api: (method: string, p: Record<string, unknown>) => Promise<unknown>;
    };
    tg.send = async (m, o) => {
      ctx.sent.push(m);
      mid++;
      if (o?.meta?.ref)
        tg.remember(o.meta.ref, { chat: '42', id: mid, at: new Date().toISOString() });
      return null;
    };
    const edits: { id: unknown; text: string }[] = [];
    const deleted: unknown[] = [];
    tg.api = async (method, p) => {
      if (method === 'editMessageText') edits.push({ id: p.message_id, text: String(p.text) });
      if (method === 'deleteMessage') deleted.push(p.message_id);
      return { ok: true, result: true, via: 'direct' };
    };
    const stop = ctx.n.bind([]);
    vi.setSystemTime(new Date('2026-10-12T10:05:00Z')); // после тихого старта
    const flush = () => new Promise((r) => setTimeout(r, 20));
    const on = async (...texts: string[]) => {
      ctx.reg.emit('inventory', 's1', {
        services: [],
        audit: {
          findings: texts.map((text) => ({ severity: 'high', text })),
          jails: [],
          pendingUpdates: 0,
        },
      });
      await flush();
    };
    await on(); // первый снимок - только запомнить
    await on('MTProxyL: прокси не работает', 'SSH: вход по паролю');
    // новое замечание - только после подтверждения следующим снимком через минуту
    expect(ctx.sent).toHaveLength(0);
    vi.setSystemTime(new Date('2026-10-12T10:06:01Z'));
    await on('MTProxyL: прокси не работает', 'SSH: вход по паролю');
    expect(ctx.sent).toHaveLength(1);
    await on('SSH: вход по паролю');
    expect(edits.at(-1)).toMatchObject({ id: 1 });
    expect(edits.at(-1)?.text).toMatch(/Устранено:\n- MTProxyL/);
    await on('SSH: вход по паролю', 'Firewall выключен');
    expect(ctx.sent).toHaveLength(1);
    vi.setSystemTime(new Date('2026-10-12T10:07:02Z'));
    await on('SSH: вход по паролю', 'Firewall выключен');
    // новое - новым сообщением со всеми открытыми, прежнее удаляется
    expect(ctx.sent).toHaveLength(2);
    expect(ctx.sent[1]).toMatch(/SSH: вход по паролю\n- Firewall выключен/);
    expect(deleted).toEqual([1]);
    await on();
    expect(ctx.sent).toHaveLength(2);
    expect(edits.at(-1)).toMatchObject({ id: 2 });
    expect(edits.at(-1)?.text).toMatch(/замечания устранены/);
    stop();
  });

  it('замечание посреди перезапуска или действия: без сообщений, подтверждение - снимком', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const ctx = await make();
    ctx.db.insert(servers).values({ id: 's1', name: 'S1', host: '203.0.113.5' }).run();
    const stop = ctx.n.bind([]);
    vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
    const on = async (...texts: string[]) => {
      ctx.reg.emit('inventory', 's1', {
        services: [],
        audit: {
          findings: texts.map((text) => ({ severity: 'high', text })),
          jails: [],
          pendingUpdates: 0,
        },
      });
      await vi.advanceTimersByTimeAsync(10);
    };
    await on();
    // fail2ban перезапускается: замечание, через минуту панель сама просит снимок - его уже нет
    await on('fail2ban не запущен');
    expect(ctx.refreshes).toEqual([]);
    await vi.advanceTimersByTimeAsync(65_000);
    expect(ctx.refreshes).toEqual([['s1', { quiet: true }]]);
    await on();
    expect(ctx.sent).toEqual([]);
    // во время действия (обновление MTProxyL) отсчёт не идёт и снимок не просится
    ctx.db
      .insert(actionLog)
      .values({ id: 'a1', serverId: 's1', kind: 'mtproxyl:update', params: {} })
      .run();
    await on('MTProxyL: прокси не работает');
    vi.setSystemTime(new Date('2026-10-12T10:20:00Z'));
    await on('MTProxyL: прокси не работает');
    await vi.advanceTimersByTimeAsync(65_000);
    expect(ctx.sent).toEqual([]);
    expect(ctx.refreshes).toHaveLength(1);
    // действие кончилось, прокси не поднялся - сообщение после подтверждения
    ctx.db.update(actionLog).set({ finishedAt: new Date().toISOString(), exitCode: 0 }).run();
    await on('MTProxyL: прокси не работает');
    expect(ctx.sent).toEqual([]);
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await on('MTProxyL: прокси не работает');
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatch(/критичные замечания\n- MTProxyL: прокси не работает/);
    stop();
  });

  it('сервис лежит во время действия - отсчёт "упал" с конца действия', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const ctx = await make();
    ctx.db.insert(servers).values({ id: 's1', name: 'S1', host: '203.0.113.5' }).run();
    const stop = ctx.n.bind([]);
    const on = (i: unknown) => ctx.reg.emit('inventory', 's1', i);
    const flush = () => new Promise((r) => setTimeout(r, 20));
    vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
    on(inv(false));
    await flush();
    ctx.db
      .insert(actionLog)
      .values({ id: 'a1', serverId: 's1', kind: 'wdtt:update', params: {} })
      .run();
    on(inv(true));
    await flush();
    vi.setSystemTime(new Date('2026-10-12T10:10:00Z'));
    on(inv(true));
    await flush();
    expect(ctx.sent).toEqual([]);
    ctx.db.update(actionLog).set({ finishedAt: new Date().toISOString(), exitCode: 0 }).run();
    vi.setSystemTime(new Date('2026-10-12T10:11:00Z'));
    on(inv(true));
    await flush();
    expect(ctx.sent).toEqual([]);
    // две минуты - от первого снимка после действия, а не от прошлого снимка во время него
    vi.setSystemTime(new Date('2026-10-12T10:12:01Z'));
    on(inv(true));
    await flush();
    expect(ctx.sent).toEqual([]);
    vi.setSystemTime(new Date('2026-10-12T10:13:01Z'));
    on(inv(true));
    await flush();
    expect(ctx.sent[0]).toMatch(/WDTT не работает/);
    stop();
  });

  it('диск и CPU по метрикам: одно сообщение на переход, флаги переживают перезапуск', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-12T10:00:00Z'));
    const ctx = await make();
    const stop = ctx.n.bind([]);
    const m = (cpu: number, disk: number) =>
      ctx.reg.emit('metrics', 's1', {
        cpuPercent: cpu,
        memTotalMb: 1000,
        memUsedMb: 100,
        diskTotalGb: 100,
        diskUsedGb: disk,
        netRxBps: 0,
        netTxBps: 0,
        uptimeSec: 1,
        load1: 1,
      });
    const flush = () => new Promise((r) => setTimeout(r, 20));
    vi.setSystemTime(new Date('2026-10-12T10:05:00Z'));
    m(95, 92);
    await flush();
    m(95, 93);
    await flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toMatch(/диск заполнен на 92%/);
    vi.setSystemTime(new Date('2026-10-12T10:21:00Z'));
    m(96, 93);
    await flush();
    expect(ctx.sent[1]).toMatch(/загрузка CPU выше 90% уже 15/);
    m(20, 80);
    await flush();
    expect(ctx.sent.slice(2).join('\n')).toMatch(/место на диске освободилось/);
    expect(ctx.sent.slice(2).join('\n')).toMatch(/загрузка CPU спала/);
    stop();
  });
});
