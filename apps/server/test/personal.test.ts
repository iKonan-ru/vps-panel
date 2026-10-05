import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { gclientBindings, gclientDevices, gclients, servers } from '../src/db/schema.js';
import { personalRoutes } from '../src/routes/personal.js';

const token = 'a'.repeat(32);
let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'personal-'));
  db = createDb(dir);
  db.insert(servers)
    .values({ id: 's1', name: 'b', host: '1.1.1.1', provider: 'Hoster', country: 'SE' } as never)
    .run();
  db.insert(gclients).values({ id: 'c', name: 'Иван <Петров>', slug: 'ivan-1', token }).run();
  db.insert(gclientBindings)
    .values([
      {
        id: 'b1',
        clientId: 'c',
        serverId: 's1',
        service: 'xui',
        ref: 'ivan-1',
        links: ['vless://u@localhost:1?x#r1-ivan-1'],
        state: 'ok',
      },
      {
        id: 'b2',
        clientId: 'c',
        serverId: 's1',
        service: 'mtproxyl',
        ref: 'ivan-1',
        links: ['tg://proxy?server=1.1.1.1&port=443&secret=ee00', 'https://t.me/proxy?x'],
        state: 'ok',
      },
    ])
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Каталог приложений: Happ на двух ОС - на странице будет выбор платформы по ОС посетителя. */
const apps = {
  list: () => ({
    apps: [
      {
        id: 'happ',
        name: 'Happ',
        platforms: [
          { os: 'android', title: 'Android', links: [{ label: 'APK', url: 'https://x/a.apk' }] },
          { os: 'windows', title: 'Windows', links: [{ label: 'EXE', url: 'https://x/a.exe' }] },
        ],
      },
    ],
  }),
};

describe('личная страница', () => {
  it('имя клиента, стеки кнопок с QR, рабочий скрипт, приложения отдельной страницей', async () => {
    const app = Fastify();
    await app.register(personalRoutes, {
      db,
      registry: { isOnline: () => false } as never,
      box: {} as never,
      env: { PANEL_PUBLIC_URL: 'https://panel.example' } as never,
      apps: apps as never,
    });
    const r = await app.inject({ method: 'GET', url: `/c/${token}` });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('<h1>Иван &lt;Петров&gt;</h1>');
    // QR у подписки и у прокси - последней кнопкой стека
    expect(r.body.match(/data-qr="/g)).toHaveLength(2);
    // приложения - на отдельной странице, на главной только ссылка на неё
    expect(r.body).not.toContain('class="apps"');
    expect(r.body).toContain(`/c/${token}/apps#vless`);
    // встроенный скрипт должен разбираться: ошибка синтаксиса ломала бы все кнопки страницы
    const script = /<script>([\s\S]*?)<\/script>/.exec(r.body)?.[1] ?? '';
    expect(script.length).toBeGreaterThan(100);
    expect(() => new Function(script)).not.toThrow();

    // страница приложений: группы по услугам клиента, сверху - ОС из ?os=
    const a = await app.inject({ method: 'GET', url: `/c/${token}/apps?os=windows` });
    expect(a.statusCode).toBe(200);
    expect(a.body).toContain('id="vless"');
    expect(a.body).toContain('id="telegram"');
    expect(a.body).not.toContain('id="awg"');
    expect(a.body).toContain('data-prefer="windows"');
    expect((await app.inject({ method: 'GET', url: `/c/${'b'.repeat(32)}/apps` })).statusCode).toBe(
      404,
    );
    await app.close();
  });

  it('заголовок "VPS Panel :: имя", порядок разделов, OpenFlux по устройствам, развёрнут первый', async () => {
    db.insert(gclientDevices)
      .values([
        { id: 'd1', clientId: 'c', name: 'Pixel', type: 'android' },
        { id: 'd2', clientId: 'c', name: 'Mac', type: 'macos' },
      ])
      .run();
    db.insert(gclientBindings)
      .values(
        ['d1', 'd2'].map((d) => ({
          id: `of-${d}`,
          clientId: 'c',
          deviceId: d,
          serverId: 's1',
          service: 'openflux',
          ref: `vp-${d}`,
          links: [`openflux://${d}`],
          state: 'ok',
        })),
      )
      .run();
    const app = Fastify();
    await app.register(personalRoutes, {
      db,
      registry: { isOnline: () => false } as never,
      box: {} as never,
      env: { PANEL_PUBLIC_URL: 'https://panel.example' } as never,
      apps: apps as never,
    });
    const r = await app.inject({ method: 'GET', url: `/c/${token}` });
    expect(r.body).toContain('<title>VPS Panel :: Иван &lt;Петров&gt;</title>');
    expect(r.headers['x-robots-tag']).toContain('noindex');
    const at = (t: string) => r.body.indexOf(`<div class="card-h">${t}</div>`);
    expect(at('Прокси для Telegram')).toBeGreaterThan(0);
    expect(at('Прокси для Telegram')).toBeLessThan(at('VPN по подписке'));
    expect(at('VPN по подписке')).toBeLessThan(at('OpenFlux'));
    // два блока устройств OpenFlux, развёрнут только первый
    expect(r.body.match(/<details class="devblk"/g)).toHaveLength(2);
    expect(r.body.match(/<details class="devblk" open>/g)).toHaveLength(1);
    await app.close();
  });
});
