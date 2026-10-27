import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceUpdate } from '@vps/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { type Db, createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import type { SecretBox } from '../src/lib/secret-box.js';
import { ServiceUpdates, cmpVersion, newest } from '../src/lib/service-updates.js';

describe('cmpVersion', () => {
  it('сравнивает по числам, v и хвост коммита не мешают', () => {
    expect(cmpVersion('1.2.13', 'v1.2.12')).toBe(1);
    expect(cmpVersion('3.5.7', '3.5.6-1a2b3c4')).toBe(1);
    expect(cmpVersion('3.5.6', '3.5.6-1a2b3c4')).toBe(0);
    expect(cmpVersion('1.10.0', '1.9.9')).toBe(1);
    expect(cmpVersion('1.2', '1.2.1')).toBe(-1);
    expect(cmpVersion('1.2.13', 'source-dev')).toBeNull();
  });
  it('newest - по номеру, не по порядку; не номера пропускает', () => {
    expect(newest(['dev', 'v26.9.30', 'v26.10.10', 'v26.6.27'])).toBe('v26.10.10');
    expect(newest([])).toBeUndefined();
  });
});

let dir: string;
let db: Db;
/** Ответы агента: менеджер 1.6.30 (последний), панель 1.2.12 (есть 1.2.13). */
let panelStatus = 'Состояние: работает (v1.2.12)';
let statusFails = false;
const registry = {
  isOnline: () => true,
  // движок (engine.versions) проверка обновлений не спрашивает - любой другой вызов ошибка
  request: async (_id: string, method: string) => {
    if (method === 'mtproxyl.status') {
      if (statusFails) throw new Error('агент не ответил');
      return {
        updateCheck: { current: '1.6.30', latest: '1.6.30', update_available: false },
        panel: panelStatus,
      };
    }
    throw new Error(`неожиданный вызов ${method}`);
  },
} as unknown as AgentRegistry;
let fetches = 0;
const fetchOut = async () => {
  fetches++;
  return new Response(
    JSON.stringify([
      { tag_name: 'v1.6.31' },
      { tag_name: 'mtproxyl-panel-v1.2.13' },
      { tag_name: 'mtproxyl-panel-v1.2.12' },
    ]),
  );
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'upd-'));
  db = createDb(dir);
  panelStatus = 'Состояние: работает (v1.2.12)';
  statusFails = false;
  fetches = 0;
  const inventory = {
    services: [{ kind: 'mtproxyl', title: 'MTProxyL', version: '1.6.30', ports: [] }],
  };
  db.insert(servers)
    .values({ id: 's1', name: 's1', host: 'h', statusCache: { inventory } } as never)
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ServiceUpdates: MTProxyL и его веб-панель (движок - не обновление)', () => {
  it('находит обновления, пишет о них один раз, после обновления строка пропадает', async () => {
    const sent: ServiceUpdate[] = [];
    const u = new ServiceUpdates(
      db,
      {} as SecretBox,
      registry,
      { warn: () => {} },
      async (_id, x) => {
        sent.push(x);
      },
      fetchOut,
    );
    const list = await u.recheck('s1');
    expect(list.map((x) => `${x.kind} ${x.current} -> ${x.latest}`)).toEqual([
      'mtproxyl-panel 1.2.12 -> 1.2.13',
    ]);
    expect(sent).toHaveLength(1);
    const v = await u.versions('s1');
    expect(Object.keys(v).sort()).toEqual(['mtproxyl', 'mtproxyl-panel']);
    expect(v.mtproxyl).toMatchObject({ current: '1.6.30', available: false });

    // повторная проверка: о тех же версиях не пишем, GitHub не спрашиваем (кэш)
    await u.recheck('s1');
    expect(sent).toHaveLength(1);
    expect(fetches).toBe(1);

    // агент не ответил: прошлый результат остаётся, плюс ошибка
    statusFails = true;
    expect((await u.recheck('s1')).map((x) => x.kind)).toEqual(['mtproxyl-panel']);
    expect((await u.versions('s1')).mtproxyl?.error).toBeTruthy();
    statusFails = false;

    // обновили панель - после перепроверки обновлений нет
    panelStatus = 'Состояние: работает (v1.2.13)';
    expect(await u.recheck('s1')).toEqual([]);

    // панель удалили - её запись пропадает
    panelStatus = 'Состояние: не установлена';
    await u.recheck('s1');
    expect((await u.versions('s1'))['mtproxyl-panel']).toBeUndefined();
  });
});

describe('ServiceUpdates: перепроверка после обновления', () => {
  it('ждёт свежий снимок; кнопка во время проверки получает её итог, а не вторую', async () => {
    let calls = 0;
    const counting = {
      ...registry,
      request: async (id: string, method: string) => {
        if (method === 'mtproxyl.status') calls++;
        return (registry.request as (i: string, m: string) => Promise<unknown>)(id, method);
      },
    } as unknown as AgentRegistry;
    const u = new ServiceUpdates(
      db,
      {} as SecretBox,
      counting,
      { warn: () => {} },
      async () => {},
      fetchOut,
    );
    u.recheck('s1');
    expect((await u.recheck('s1')).map((x) => x.kind)).toEqual(['mtproxyl-panel']);
    expect(calls).toBe(1);

    // после обновления: проверка - когда придёт снимок; кнопка в это время ждёт её же
    panelStatus = 'Состояние: работает (v1.2.13)';
    let fresh = () => {};
    const snap = new Promise<void>((r) => {
      fresh = r;
    });
    const after = u.recheck('s1', snap);
    const button = u.recheck('s1');
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toBe(1);
    fresh();
    expect(await after).toEqual([]);
    expect(await button).toEqual([]);
    expect(calls).toBe(2);
  });
});
