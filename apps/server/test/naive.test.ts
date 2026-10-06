import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
import { naiveLink, naivePassword, parseNaiveLink } from '../src/lib/gclient-services.js';
import { buildBrowserSubscription } from '../src/lib/subscription.js';
import { crc32, zip } from '../src/lib/zip.js';
import { personalRoutes } from '../src/routes/personal.js';
import { subscriptionRoutes } from '../src/routes/subscription.js';

/** Прокси для браузера: ссылка, подписка расширения, архив, личная страница. */

const link = (o: Partial<Parameters<typeof naiveLink>[0]> = {}) =>
  naiveLink({
    user: 'ivan-1',
    password: 'Abc123Abc123Abc123Abc123',
    domain: 'hoster.example.com',
    port: 8444,
    on443: true,
    secret: 'a1b2c3d4e5f6a7b8c9d0.test',
    title: 'Швеция :: Hoster',
    ...o,
  });

describe('ссылка naive+https', () => {
  it('собирается и разбирается обратно; 443 - первым портом', () => {
    const l = link();
    expect(
      l.startsWith('naive+https://ivan-1:Abc123Abc123Abc123Abc123@hoster.example.com:8444?'),
    ).toBe(true);
    expect(parseNaiveLink(l)).toEqual({
      user: 'ivan-1',
      password: 'Abc123Abc123Abc123Abc123',
      host: 'hoster.example.com',
      port: 8444,
      ports: [443, 8444],
      probe: 'a1b2c3d4e5f6a7b8c9d0.test',
      title: 'Швеция :: Hoster',
    });
    expect(parseNaiveLink(link({ on443: false }))?.ports).toEqual([8444]);
    expect(parseNaiveLink('vless://x@y:1')).toBeNull();
  });

  it('пароль - 24 латинских буквы и цифры (агент принимает 16-64)', () => {
    for (let i = 0; i < 20; i++) expect(naivePassword()).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(naivePassword()).not.toBe(naivePassword());
  });
});

describe('zip', () => {
  it('crc32 и распаковка: имя UTF-8, данные совпадают', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
    const data = Buffer.from('привет, расширение'.repeat(20));
    const z = zip([{ name: 'папка/файл.txt', data }]);
    expect(z.readUInt32LE(0)).toBe(0x04034b50);
    const nameLen = z.readUInt16LE(26);
    expect(z.subarray(30, 30 + nameLen).toString('utf8')).toBe('папка/файл.txt');
    const size = z.readUInt32LE(18);
    const out = inflateRawSync(z.subarray(30 + nameLen, 30 + nameLen + size));
    expect(out.equals(data)).toBe(true);
    // конец центрального каталога: одна запись
    expect(z.readUInt32LE(z.length - 22)).toBe(0x06054b50);
    expect(z.readUInt16LE(z.length - 12)).toBe(1);
  });
});

const token = 'b'.repeat(32);
let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'naive-'));
  db = createDb(dir);
  db.insert(servers)
    .values({ id: 's1', name: 'b', host: '1.1.1.1', provider: 'Hoster', country: 'SE' } as never)
    .run();
  db.insert(servers)
    .values({ id: 's2', name: 'a', host: '2.2.2.2', provider: 'Kappa', country: 'FI' } as never)
    .run();
  db.insert(gclients).values({ id: 'c', name: 'Иван', slug: 'ivan-1', token }).run();
  db.insert(gclientBindings)
    .values([
      {
        id: 'n1',
        clientId: 'c',
        serverId: 's1',
        service: 'naive',
        ref: 'ivan-1',
        links: [link()],
        state: 'ok',
      },
      {
        id: 'n2',
        clientId: 'c',
        serverId: 's2',
        service: 'naive',
        ref: 'ivan-1',
        links: [link({ domain: 'kappa.example.com', on443: false, title: 'Финляндия :: Kappa' })],
        state: 'ok',
      },
    ])
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('buildBrowserSubscription', () => {
  it('серверы по имени, только исправные; выключенный - suspended; чужой токен - null', () => {
    const s = buildBrowserSubscription(db, token);
    expect(s?.suspended).toBe(false);
    expect(s?.servers.map((x) => [x.id, x.host, x.ports])).toEqual([
      ['s2', 'kappa.example.com', [8444]],
      ['s1', 'hoster.example.com', [443, 8444]],
    ]);
    expect(s?.servers[1]).toMatchObject({
      user: 'ivan-1',
      probe: 'a1b2c3d4e5f6a7b8c9d0.test',
      title: 'Швеция :: Hoster',
    });
    db.update(gclientBindings).set({ state: 'error' }).where(eq(gclientBindings.id, 'n2')).run();
    expect(buildBrowserSubscription(db, token)?.servers).toHaveLength(1);
    db.update(servers).set({ gclients: false }).where(eq(servers.id, 's1')).run();
    expect(buildBrowserSubscription(db, token)?.servers).toHaveLength(0);
    db.update(gclients).set({ enabled: false }).run();
    expect(buildBrowserSubscription(db, token)).toEqual({
      name: 'Иван',
      suspended: true,
      servers: [],
    });
    expect(buildBrowserSubscription(db, 'c'.repeat(32))).toBeNull();
  });
});

describe('личная страница: Браузер Chrome', () => {
  it('блок со ссылкой на архив; архив - файлы расширения и config.json с подпиской клиента', async () => {
    const ext = join(dir, 'ext');
    mkdirSync(ext);
    writeFileSync(join(ext, 'manifest.json'), '{"manifest_version":3}');
    writeFileSync(join(ext, 'bg.js'), '// bg');
    writeFileSync(join(ext, 'config.json'), '{"subscription":"чужая"}');
    writeFileSync(join(ext, 'README.md'), '# для разработки');
    const app = Fastify();
    await app.register(personalRoutes, {
      db,
      registry: { isOnline: () => false } as never,
      box: {} as never,
      env: {
        PANEL_PUBLIC_URL: 'https://panel.example',
        SUB_PUBLIC_URL: 'https://sub.example',
        EXTENSION_DIR: ext,
        FILES_DIR: join(dir, 'nofiles'),
      } as never,
      apps: { list: () => ({ apps: [] }) } as never,
    });
    const page = await app.inject({ method: 'GET', url: `/c/${token}` });
    expect(page.body).toContain('<div class="card-h">Браузер Chrome без программ</div>');
    expect(page.body).toContain(`href="/c/${token}/chrome.zip"`);
    const r = await app.inject({ method: 'GET', url: `/c/${token}/chrome.zip` });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    const z = r.rawPayload;
    // имена файлов из центрального каталога
    const names: string[] = [];
    let off = z.readUInt32LE(z.length - 6);
    while (z.readUInt32LE(off) === 0x02014b50) {
      const n = z.readUInt16LE(off + 28);
      names.push(z.subarray(off + 46, off + 46 + n).toString('utf8'));
      off += 46 + n;
    }
    expect(names.sort()).toEqual([
      'vps-panel-proxy/bg.js',
      'vps-panel-proxy/config.json',
      'vps-panel-proxy/manifest.json',
    ]);
    // README.md (для разработки) не попадает; config.json - свой, со ссылкой подписки этого
    // клиента (чужой из каталога не попадает)
    const at = z.indexOf(Buffer.from('vps-panel-proxy/config.json'));
    const local = z.lastIndexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]), at);
    const size = z.readUInt32LE(local + 18);
    const nameLen = z.readUInt16LE(local + 26);
    const cfg = JSON.parse(
      inflateRawSync(z.subarray(local + 30 + nameLen, local + 30 + nameLen + size)).toString(),
    );
    expect(cfg).toEqual({ subscription: `https://sub.example/sub/${token}/browser` });
    // выключенный клиент - архива нет
    db.update(gclients).set({ enabled: false }).run();
    expect((await app.inject({ method: 'GET', url: `/c/${token}/chrome.zip` })).statusCode).toBe(
      404,
    );
    await app.close();
  });
});

describe('/sub/<токен>/browser', () => {
  it('JSON подписки с версией расширения и архивом клиента; нет манифеста - без extension', async () => {
    const ext = join(dir, 'ext2');
    mkdirSync(ext);
    writeFileSync(join(ext, 'manifest.json'), '{"manifest_version":3,"version":"1.2.3"}');
    const env = {
      EXTENSION_DIR: ext,
      SUB_PUBLIC_URL: 'https://sub.example',
      PANEL_PUBLIC_URL: 'https://p',
    };
    const app = Fastify();
    await app.register(subscriptionRoutes, { db, env: env as never });
    const r = await app.inject({ method: 'GET', url: `/sub/${token}/browser` });
    expect(r.statusCode).toBe(200);
    const j = r.json();
    expect(j.servers).toHaveLength(2);
    expect(j.extension).toEqual({
      version: '1.2.3',
      download: `https://sub.example/c/${token}/chrome.zip`,
    });
    expect(
      (await app.inject({ method: 'GET', url: `/sub/${'d'.repeat(32)}/browser` })).statusCode,
    ).toBe(404);
    await app.close();
    const app2 = Fastify();
    await app2.register(subscriptionRoutes, {
      db,
      env: { ...env, EXTENSION_DIR: join(dir, 'none') } as never,
    });
    expect(
      (await app2.inject({ method: 'GET', url: `/sub/${token}/browser` })).json().extension,
    ).toBeUndefined();
    await app2.close();
  });
});

describe('расширение Firefox', () => {
  it('updates.json и архивы - без входа; архив на личной странице - клиенту; нет архива - нет блока', async () => {
    const files = join(dir, 'files');
    mkdirSync(join(files, 'firefox'), { recursive: true });
    writeFileSync(join(files, 'firefox', 'updates.json'), '{"addons":{}}');
    writeFileSync(join(files, 'firefox', 'vps-panel-proxy-1.4.0.xpi'), 'xpi-140');
    writeFileSync(join(files, 'firefox', 'vps-panel-proxy-1.10.0.xpi'), 'xpi-1100');
    writeFileSync(join(files, 'firefox', 'other.txt'), 'secret');
    const env = {
      EXTENSION_DIR: join(dir, 'none'),
      FILES_DIR: files,
      SUB_PUBLIC_URL: 'https://sub.example',
      PANEL_PUBLIC_URL: 'https://p',
      NODE_ENV: 'test',
    };
    const app = Fastify();
    await app.register(subscriptionRoutes, { db, env: env as never });
    await app.register(personalRoutes, {
      db,
      registry: { isOnline: () => false } as never,
      box: {} as never,
      env: env as never,
      apps: { list: () => ({ apps: [] }) } as never,
    });
    const u = await app.inject({ method: 'GET', url: '/sub/firefox/updates.json' });
    expect(u.statusCode).toBe(200);
    expect(u.headers['content-type']).toContain('application/json');
    const x = await app.inject({ method: 'GET', url: '/sub/firefox/vps-panel-proxy-1.4.0.xpi' });
    expect(x.headers['content-type']).toBe('application/x-xpinstall');
    expect(x.body).toBe('xpi-140');
    for (const bad of ['other.txt', '..%2Fother.txt', 'vps-panel-proxy-1.0.xpi.bak'])
      expect((await app.inject({ method: 'GET', url: `/sub/firefox/${bad}` })).statusCode).toBe(
        404,
      );
    // последняя версия - по числам, не по строке
    const page = await app.inject({ method: 'GET', url: `/c/${token}` });
    expect(page.body).toContain('Браузер Firefox без программ');
    const f = await app.inject({ method: 'GET', url: `/c/${token}/firefox.xpi` });
    expect(f.headers['content-type']).toBe('application/x-xpinstall');
    expect(f.body).toBe('xpi-1100');
    db.update(gclients).set({ enabled: false }).run();
    expect((await app.inject({ method: 'GET', url: `/c/${token}/firefox.xpi` })).statusCode).toBe(
      404,
    );
    db.update(gclients).set({ enabled: true }).run();
    rmSync(join(files, 'firefox'), { recursive: true });
    expect((await app.inject({ method: 'GET', url: `/c/${token}` })).body).not.toContain('Firefox');
    await app.close();
  });
});
