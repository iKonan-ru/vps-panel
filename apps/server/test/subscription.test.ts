import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
import { countryFlag } from '../src/lib/awg-config.js';
import { buildSubscription, buildWdttSubscription, rewriteLink } from '../src/lib/subscription.js';
import { wdttLinks } from '../src/lib/wdtt.js';

describe('rewriteLink', () => {
  const raw =
    'vless://u@localhost:24443?flow=xtls-rprx-vision&security=reality&type=tcp#reality-ivan-5eae';
  it('адрес сервера вместо localhost, подпись "(флаг) Страна :: Хостинг" через %20', () => {
    expect(
      rewriteLink(raw, {
        host: '1.2.3.4',
        title: 'Финляндия :: Hoster',
        email: 'ivan-5eae',
        withInbound: false,
      }),
    ).toBe(
      `vless://u@1.2.3.4:24443?flow=xtls-rprx-vision&security=reality&type=tcp#${encodeURIComponent('Финляндия :: Hoster')}`,
    );
    expect(
      rewriteLink(raw, { host: '1.2.3.4', title: 'T', email: 'ivan-5eae', withInbound: false }),
    ).not.toContain('+');
  });
  it('несколько inbound-ов - имя inbound-а без email; внешний адрес не трогается', () => {
    const l = rewriteLink(raw, {
      host: 'h',
      title: 'Hoster',
      email: 'ivan-5eae',
      withInbound: true,
    });
    expect(decodeURIComponent(l.split('#')[1] ?? '')).toBe('Hoster :: reality');
    const ext = rewriteLink('vless://u@cdn.example:443?x=1#a-ivan-5eae', {
      host: 'h',
      title: 'T',
      email: 'ivan-5eae',
      withInbound: false,
    });
    expect(ext.startsWith('vless://u@cdn.example:443')).toBe(true);
  });
  it('флаг страны', () => {
    expect(countryFlag('FI')).toBe(String.fromCodePoint(0x1f1eb, 0x1f1ee));
    expect(countryFlag('Москва')).toBe('');
  });
});

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sub-'));
  db = createDb(dir);
  db.insert(servers)
    .values({ id: 's1', name: 'b', host: '1.1.1.1', provider: 'Hoster', country: 'FI' } as never)
    .run();
  db.insert(servers)
    .values({ id: 's2', name: 'a', host: '2.2.2.2', provider: 'Kappa', country: 'DE' } as never)
    .run();
  db.insert(gclients).values({ id: 'c', name: 'Иван', slug: 'ivan-1', token: 'tok' }).run();
  for (const [id, s, links] of [
    ['b1', 's1', ['vless://u@localhost:1?x#r1-ivan-1', 'vless://u@localhost:2?x#r2-ivan-1']],
    ['b2', 's2', ['vless://u@127.0.0.1:3?x#r3-ivan-1']],
  ] as const)
    db.insert(gclientBindings)
      .values({
        id,
        clientId: 'c',
        serverId: s,
        service: 'xui',
        ref: 'ivan-1',
        links: [...links],
        state: 'ok',
      })
      .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildSubscription', () => {
  it('ссылки всех серверов, по имени сервера; выключенный - пусто; чужой токен - null', () => {
    const s = buildSubscription(db, 'tok');
    expect(s?.links).toHaveLength(3);
    expect(s?.links[0]).toContain('@2.2.2.2:3');
    expect(decodeURIComponent(s?.links[0]?.split('#')[1] ?? '')).toContain('Германия :: Kappa');
    expect(decodeURIComponent(s?.links[1]?.split('#')[1] ?? '')).toContain(
      `${countryFlag('FI')} Финляндия :: Hoster :: r1`,
    );
    expect(buildSubscription(db, 'nope')).toBeNull();
    // сервер выключили из глобальных клиентов - его ссылок нет, даже пока привязки на месте
    db.update(servers).set({ gclients: false }).where(eq(servers.id, 's2')).run();
    expect(buildSubscription(db, 'tok')?.links).toHaveLength(2);
    db.update(gclients).set({ enabled: false }).run();
    expect(buildSubscription(db, 'tok')?.links).toEqual([]);
  });
});

describe('buildWdttSubscription', () => {
  it('профиль на сервер из ссылки qwdtt://; выключенный - пусто; чужой токен - null', () => {
    const l = wdttLinks({
      host: '1.1.1.1',
      dtlsPort: 56000,
      wgPort: 56001,
      password: 'pa ss',
      hashes: ['h1', 'h2'],
      name: 'Финляндия :: Hoster',
    });
    db.insert(gclientBindings)
      .values({
        id: 'w1',
        clientId: 'c',
        serverId: 's1',
        service: 'wdtt',
        ref: 'ivan-1',
        links: [l.qwdtt, l.wdtt],
        state: 'ok',
      })
      .run();
    expect(buildWdttSubscription(db, 'tok')?.profiles).toEqual([
      {
        name: 'Финляндия :: Hoster',
        peer: '1.1.1.1:56000',
        hashes: 'h1,h2',
        workers: 9,
        port: 9000,
        password: 'pa ss',
      },
    ]);
    expect(buildWdttSubscription(db, 'nope')).toBeNull();
    db.update(gclients).set({ enabled: false }).run();
    expect(buildWdttSubscription(db, 'tok')?.profiles).toEqual([]);
  });
});
