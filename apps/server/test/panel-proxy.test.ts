import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, servers } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';
import { slugify } from '../src/lib/panel-proxy.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-proxy-'));
const env = loadEnv({
  NODE_ENV: 'test',
  DATA_DIR: dir,
  PANEL_PUBLIC_URL: 'https://panel.example',
  // прежний адрес панели по IP (vps-panel domain после установки без домена)
  PANEL_SNI: '203.0.113.10',
  SUB_DOMAIN: 'sub.panel.example',
});
let built: Awaited<ReturnType<typeof buildApp>>;
let port = 0;
let session = '';

const inventory = {
  services: [
    { kind: 'xui', title: '3X-UI', ports: [], panelUrl: 'https://1.2.3.4:2053/secretpath/' },
  ],
};

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  built.db
    .insert(servers)
    .values({ id: 's1', name: 'NetCore', host: '1.2.3.4', statusCache: { inventory } } as never)
    .run();
  built.db
    .insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  session = (await createSession(built.db, 'a1', '127.0.0.1', 'test')).token;
  const addr = await built.app.listen({ port: 0, host: '127.0.0.1' });
  port = Number(new URL(addr).port);
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Запрос с нужным Host напрямую в сервер (как от Caddy). */
function get(host: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
    (resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, headers: { host, ...headers } }, (res) => {
        let body = '';
        res.on('data', (d) => {
          body += d;
        });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      });
      r.on('error', reject);
      r.end();
    },
  );
}

describe('поддомены панелей сервисов', () => {
  it('слаг из имени', () => {
    expect(slugify('NetCore')).toBe('netcore');
    expect(slugify('Web.io (-)')).toBe('web-io');
    expect(slugify('Хостинг 1')).toBe('hosting-1');
  });

  it('ask: сертификат только на известный поддомен', async () => {
    expect(
      (await get('panel.example', '/api/proxy/ask?domain=netcore-xui.panel.example')).status,
    ).toBe(200);
    expect(
      (await get('panel.example', '/api/proxy/ask?domain=netcore-mtproxyl.panel.example')).status,
    ).toBe(404);
    expect((await get('panel.example', '/api/proxy/ask?domain=evil.example')).status).toBe(404);
    // свой IP панели: запросы без SNI Caddy ведёт через ask - иначе рукопожатие рвётся
    expect((await get('panel.example', '/api/proxy/ask?domain=203.0.113.10')).status).toBe(200);
    expect((await get('panel.example', '/api/proxy/ask?domain=203.0.113.11')).status).toBe(404);
  });

  it('неизвестный поддомен - 404, без входа - на вход через панель, xhr - 401', async () => {
    expect((await get('nope-xui.panel.example', '/')).status).toBe(404);
    const nav = await get('netcore-xui.panel.example', '/secretpath/panel/', {
      accept: 'text/html',
    });
    expect(nav.status).toBe(302);
    expect(nav.headers.location).toBe(
      'https://panel.example/api/proxy/open/netcore-xui?back=%2Fsecretpath%2Fpanel%2F',
    );
    expect((await get('netcore-xui.panel.example', '/api/x')).status).toBe(401);
  });

  it('open: без сессии - на вход с возвратом; с сессией - тикет; тикет - cookie поддомена', async () => {
    const anon = await get('panel.example', '/api/proxy/open/netcore-xui');
    expect(anon.status).toBe(302);
    expect(String(anon.headers.location)).toBe(
      `/login?next=${encodeURIComponent('/api/proxy/open/netcore-xui')}`,
    );
    // сначала - страница "Открываю панель" интерфейса, с неё - обратно с go=1
    const page = await get('panel.example', '/api/proxy/open/netcore-xui?back=%2Fx', {
      cookie: `__Host-vps_session=${session}`,
    });
    expect(page.status).toBe(302);
    expect(page.headers.location).toBe('/open/netcore-xui?back=%2Fx');
    const open = await get('panel.example', '/api/proxy/open/netcore-xui?go=1', {
      cookie: `__Host-vps_session=${session}`,
    });
    expect(open.status).toBe(302);
    const loc = new URL(String(open.headers.location));
    expect(loc.host).toBe('netcore-xui.panel.example');
    expect(loc.pathname).toBe('/__vps/auth');
    const auth = await get('netcore-xui.panel.example', `${loc.pathname}${loc.search}`);
    expect(auth.status).toBe(302);
    expect(auth.headers.location).toBe('/secretpath/');
    const cookie = String((auth.headers['set-cookie'] as string[])[0]);
    expect(cookie).toMatch(/^__Host-vps_proxy=.+; Path=\/; HttpOnly; Secure; SameSite=Lax/);
    // тикет одноразовый
    const again = await get('netcore-xui.panel.example', `${loc.pathname}${loc.search}`);
    expect(String(again.headers['set-cookie'] ?? '')).toBe('');
    // с cookie, но агент не на связи - понятная страница, процесс жив
    const off = await get('netcore-xui.panel.example', '/secretpath/', {
      cookie: cookie.split(';')[0] ?? '',
    });
    expect(off.status).toBe(502);
    expect(off.body).toContain('Сервер не на связи');
    // подделанная cookie - как без входа
    const forged = await get('netcore-xui.panel.example', '/x', {
      cookie: `__Host-vps_proxy=netcore-xui.${'a'.repeat(64)}.${Date.now() + 1e6}.bad`,
    });
    expect(forged.status).toBe(401);
  });

  it('probe: без сессии - 401, агент не на связи - шаг agent, неизвестная метка - target', async () => {
    const url = '/api/proxy/probe/netcore-xui';
    expect((await built.app.inject({ method: 'POST', url })).statusCode).toBe(401);
    const cookie = `__Host-vps_session=${session}`;
    const r = await built.app.inject({ method: 'POST', url, headers: { cookie } });
    expect(r.json()).toMatchObject({ ok: false, stage: 'agent', server: 'NetCore', kind: 'xui' });
    const none = await built.app.inject({
      method: 'POST',
      url: '/api/proxy/probe/nope-xui',
      headers: { cookie },
    });
    expect(none.json()).toMatchObject({ ok: false, stage: 'target' });
  });

  it('websocket без cookie - 401, процесс жив', async () => {
    const res = await new Promise<string>((resolve) => {
      const s = connect(port, '127.0.0.1', () => {
        s.write(
          'GET /ws HTTP/1.1\r\nHost: netcore-xui.panel.example\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n',
        );
      });
      let d = '';
      s.on('data', (b) => {
        d += b;
      });
      s.on('close', () => resolve(d));
    });
    expect(res).toContain('401');
    expect((await get('panel.example', '/api/health')).status).toBe(200);
  });

  it('sub.<домен> и прочие имена идут в панель, а не в прокси', async () => {
    // личная страница с неизвестным токеном - 404 самой панели (не страница прокси)
    const sub = await get('sub.panel.example', `/c/${'0'.repeat(32)}`);
    expect(sub.body).not.toContain('Панель не найдена');
    expect((await get('sub.panel.example', '/api/health')).status).toBe(200);
    expect((await get('www.panel.example', '/api/health')).status).toBe(200);
    expect((await get('-xui.panel.example', '/api/health')).status).toBe(200);
  });

  it('панель на своём имени работает как раньше', async () => {
    expect((await get('panel.example', '/api/health')).status).toBe(200);
    expect((await get('panel.example', '/api/servers')).status).toBe(401);
  });
});
