import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, gclientBindings, gclientExts, gclients, servers } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';
import { browserOf, extServers, extsByClient, pruneExts } from '../src/lib/browser-ext.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-ext-'));
const extDir = join(dir, 'ext');
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir, EXTENSION_DIR: extDir });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
const token = 'a'.repeat(32);
const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36';

beforeAll(async () => {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(extDir);
  writeFileSync(join(extDir, 'manifest.json'), JSON.stringify({ version: '1.5.0' }));
  built = await buildApp({ env, db: createDb(':memory:') });
  built.db
    .insert(servers)
    .values({ id: 's1', name: 'NetCore', host: '1.2.3.4' } as never)
    .run();
  built.db
    .insert(gclients)
    .values({ id: 'c1', name: 'Иван', token, slug: 'ivan' } as never)
    .run();
  built.db
    .insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  const s = await createSession(built.db, 'a1', '127.0.0.1', 'test');
  cookie = `vps_session=${s.token}`;
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const report = (body: Record<string, unknown>, t = token) =>
  built.app.inject({ method: 'POST', url: `/sub/${t}/browser/status`, payload: body });

async function exts() {
  const r = await built.app.inject({ method: 'GET', url: '/api/gclients/c1', headers: { cookie } });
  return r.json().browserExt as Record<string, unknown>[];
}

describe('статус расширения для браузера', () => {
  it('старая версия без отчётов: видно только, что брала подписку', async () => {
    const r = await built.app.inject({
      method: 'GET',
      url: `/sub/${token}/browser`,
      headers: { 'user-agent': CHROME_UA },
    });
    expect(r.statusCode).toBe(200);
    expect(await exts()).toMatchObject([
      { browser: 'chrome', version: null, enabled: null, outdated: true, online: false },
    ]);
  });

  it('отчёт: включено, сервер по имени, на связи; строка старой версии того же браузера уходит', async () => {
    const r = await report({
      install: '0123456789abcdef',
      version: '1.5.0',
      browser: 'chrome',
      enabled: true,
      server: 's1',
      error: '',
    });
    expect(r.statusCode).toBe(204);
    const list = await exts();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      browser: 'chrome',
      version: '1.5.0',
      outdated: false,
      enabled: true,
      server: 'NetCore',
      online: true,
    });
    // новая версия берёт подписку с заголовком - строка старой не появляется снова
    await built.app.inject({
      method: 'GET',
      url: `/sub/${token}/browser`,
      headers: { 'user-agent': CHROME_UA, 'x-vps-ext': '0123456789abcdef' },
    });
    expect(await exts()).toHaveLength(1);
  });

  it('второй браузер - вторая строка; "Авто"; устаревшая версия; в списке клиентов тоже', async () => {
    await report({
      install: 'fedcba9876543210',
      version: '1.4.9',
      browser: 'firefox',
      enabled: false,
      server: 'auto',
      error: 'Подписка не обновилась',
    });
    const list = await exts();
    expect(list).toHaveLength(2);
    expect(list.find((e) => e.browser === 'firefox')).toMatchObject({
      server: 'Авто',
      enabled: false,
      outdated: true,
      error: 'Подписка не обновилась',
    });
    const rows = (
      await built.app.inject({ method: 'GET', url: '/api/gclients', headers: { cookie } })
    ).json();
    expect(rows[0].browserExt).toHaveLength(2);
  });

  it('чужой токен - 404, неверный отчёт - 400, без входа в /api не видно', async () => {
    const ok = {
      install: '0123456789abcdef',
      version: '1.5.0',
      browser: 'chrome',
      enabled: true,
      server: 'auto',
    };
    expect((await report(ok, 'b'.repeat(32))).statusCode).toBe(404);
    expect((await report({ ...ok, install: 'не то' })).statusCode).toBe(400);
    expect((await report({ ...ok, error: 'x'.repeat(301) })).statusCode).toBe(400);
    expect((await built.app.inject({ method: 'GET', url: '/api/gclients/c1' })).statusCode).toBe(
      401,
    );
  });

  it('на связи - 20 минут; молчащие 60 дней забываются', () => {
    const later = Date.now() + 21 * 60_000;
    const m = extsByClient(built.db, ['c1'], '1.5.0', later);
    expect(m.get('c1')?.every((e) => !e.online)).toBe(true);
    pruneExts(built.db, Date.now() + 61 * 86_400_000);
    expect(built.db.select().from(gclientExts).all()).toHaveLength(0);
  });

  it('браузер по User-Agent', () => {
    expect(browserOf(CHROME_UA)).toBe('chrome');
    expect(
      browserOf('Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'),
    ).toBe('firefox');
    expect(browserOf('curl/8')).toBe('other');
  });
});

describe('через какой сервер идёт браузер (точка "на связи" у прокси для браузера)', () => {
  it('выбранный сервер - он, "Авто" - первый доступный в цепочке, молчащие и выключенные - нет', () => {
    const db = createDb(':memory:');
    const t = 'd'.repeat(32);
    db.insert(gclients)
      .values({ id: 'c9', name: 'Оля', token: t, slug: 'olya' } as never)
      .run();
    for (const [id, name] of [
      ['sa', 'Alpha'],
      ['sb', 'Beta'],
    ])
      db.insert(servers)
        .values({ id, name, host: '1.1.1.1' } as never)
        .run();
    for (const id of ['sa', 'sb'])
      db.insert(gclientBindings)
        .values({
          id: `b-${id}`,
          clientId: 'c9',
          serverId: id,
          service: 'naive',
          state: 'ok',
          links: [`naive+https://olya:pw@${id}.example.com:8444?probe=x#${id}`],
        } as never)
        .run();
    const now = Date.now();
    const put = (install: string, serverId: string, enabled: boolean, minutesAgo: number) =>
      db
        .insert(gclientExts)
        .values({
          id: `c9:${install}`,
          clientId: 'c9',
          browser: 'chrome',
          version: '1.5.0',
          enabled,
          serverId,
          seenAt: new Date(now - minutesAgo * 60_000).toISOString(),
        } as never)
        .onConflictDoUpdate({
          target: gclientExts.id,
          set: { serverId, enabled, seenAt: new Date(now - minutesAgo * 60_000).toISOString() },
        })
        .run();
    const all = () => true;
    put('1111111111111111', 'auto', true, 1);
    expect([...extServers(db, 'c9', t, all, now).keys()]).toEqual(['sa']);
    // первый в цепочке не работает - браузер ушёл на следующий
    expect([...extServers(db, 'c9', t, (sid) => sid !== 'sa', now).keys()]).toEqual(['sb']);
    expect(extServers(db, 'c9', t, all, now).get('sa')?.auto).toBe(true);
    put('1111111111111111', 'sb', true, 1);
    expect([...extServers(db, 'c9', t, all, now).keys()]).toEqual(['sb']);
    put('1111111111111111', 'sb', false, 1);
    expect(extServers(db, 'c9', t, all, now).size).toBe(0);
    put('1111111111111111', 'sb', true, 25);
    expect(extServers(db, 'c9', t, all, now).size).toBe(0);
  });
});
