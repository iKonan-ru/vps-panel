import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNotifyEvents } from '@vps/protocol';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDb } from '../src/db/index.js';
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
  const reg = Object.assign(new EventEmitter(), {
    isOnline: () => false,
    isUpdating: () => false,
  });
  const n = new Notifier(db, reg as never, tg);
  return { db, tg, sent, reg, n };
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
});
