import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SUB_APPS, subAppLink } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, gclientBindings, gclients, servers } from '../src/db/schema.js';
import { AppReleases } from '../src/lib/apps.js';
import { createSession } from '../src/lib/auth.js';

const URL_ = 'https://sub.example/sub/abc';

describe('ссылки импорта подписки', () => {
  it('у каждого приложения своя схема; адрес кодируется там, где он в параметре', () => {
    const name = 'Иван И.';
    expect(subAppLink('happ', URL_, name)).toBe(`happ://add/${URL_}`);
    expect(subAppLink('incy', URL_, name)).toBe(`incy://import/${URL_}`);
    expect(subAppLink('hiddify', URL_, name)).toBe(
      `hiddify://install-config?url=${encodeURIComponent(URL_)}#${encodeURIComponent(name)}`,
    );
    expect(subAppLink('v2rayng', URL_, name)).toBe(
      `v2rayng://install-sub?url=${encodeURIComponent(URL_)}#${encodeURIComponent(name)}`,
    );
    // без схемы (v2rayN) и неизвестное приложение - сама подписка
    expect(subAppLink('v2rayn', URL_, name)).toBe(URL_);
    expect(subAppLink('nope', URL_, name)).toBe(URL_);
  });

  it('каждое приложение подписки есть в каталоге приложений как приложение VLESS', () => {
    const catalog = new AppReleases(createDb(':memory:'), fetch, { warn: () => {} }).list().apps;
    for (const a of SUB_APPS) {
      const c = catalog.find((x) => x.id === a.id);
      expect(c?.purpose, a.id).toMatch(/^VLESS/);
      expect(c?.platforms.length, a.id).toBeGreaterThan(0);
    }
  });
});

const dir = mkdtempSync(join(tmpdir(), 'vps-subapps-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir, SUB_DOMAIN: 'sub.example' });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
const token = 'a'.repeat(32);

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  await built.app.ready();
  const db = built.db;
  db.insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  cookie = `vps_session=${(await createSession(db, 'a1', '127.0.0.1', 't')).token}`;
  db.insert(gclients).values({ id: 'c1', name: 'Иван', slug: 'ivan-0001', token }).run();
  db.insert(servers)
    .values({ id: 's1', name: 'Breezy Owl', host: '203.0.113.5', gclients: true } as never)
    .run();
  db.insert(gclientBindings)
    .values({
      id: 'b1',
      clientId: 'c1',
      serverId: 's1',
      service: 'xui',
      ref: 'ivan-0001',
      links: ['vless://u@203.0.113.5:443#x'],
      state: 'ok',
    })
    .run();
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

const patch = (body: unknown) =>
  built.app.inject({
    method: 'PATCH',
    url: '/api/gclients/c1',
    headers: { cookie },
    payload: body as object,
  });
const page = async () => (await built.app.inject({ method: 'GET', url: `/c/${token}` })).body;

describe('приложение клиента', () => {
  it('личная страница: выбор приложений, без своего - Happ, кнопка каждого со своей ссылкой', async () => {
    const html = await page();
    expect(html).toContain('data-subapps data-default="happ"');
    for (const a of SUB_APPS) expect(html).toContain(`data-app="${a.id}"`);
    expect(html).toContain(`href="incy://import/https://sub.example/sub/${token}"`);
    expect(html).toContain('data-app="v2rayng" data-os="android"');
  });

  it('PATCH: задать, снять, неизвестное - 400; страница выбирает приложение клиента', async () => {
    expect((await patch({ apps: { vless: 'incy' } })).statusCode).toBe(200);
    const row = () => built.db.select().from(gclients).where(eq(gclients.id, 'c1')).get();
    expect(row()?.apps).toEqual({ vless: 'incy' });
    expect(await page()).toContain('data-subapps data-default="incy"');
    const detail = await built.app.inject({
      method: 'GET',
      url: '/api/gclients/c1',
      headers: { cookie },
    });
    expect(detail.json().client.apps).toEqual({ vless: 'incy' });

    expect((await patch({ apps: { vless: 'nope' } })).statusCode).toBe(400);
    expect(row()?.apps).toEqual({ vless: 'incy' });
    // правка имени приложение не трогает
    expect((await patch({ name: 'Иван П.' })).statusCode).toBe(200);
    expect(row()?.apps).toEqual({ vless: 'incy' });

    expect((await patch({ apps: { vless: null } })).statusCode).toBe(200);
    expect(row()?.apps).toEqual({});
  });
});
