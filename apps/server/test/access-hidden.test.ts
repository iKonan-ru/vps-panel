import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { findCommand, validateAnswers } from '../src/commands/index.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { access, admins, servers } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-access-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  await built.app.ready();
  const { db } = built;
  db.insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  cookie = `vps_session=${(await createSession(db, 'a1', '127.0.0.1', 't')).token}`;
  db.insert(servers)
    .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
    .run();
  db.insert(access)
    .values([
      { id: 'x1', serverId: 's1', kind: 'xui-api', title: 'API 3X-UI', fields: [] },
      { id: 'x2', serverId: 's1', kind: 'xui', title: 'Панель 3X-UI', fields: [] },
    ] as never)
    .run();
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Доступы сервера', () => {
  it('служебный токен API 3X-UI не показывается', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/api/servers/s1/access',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { kind: string }[]).map((r) => r.kind)).toEqual(['xui']);
  });

  it('установка MTProxyL пишет в Доступы только панель, без ссылок', () => {
    const c = findCommand('mtproxyl');
    const out = c?.access?.({
      panelUrl: 'https://panel.example',
      server: { id: 's1', name: 'Hoster', host: '1.1.1.1' },
      answers: { MTP_USER: 'admin', MTP_PASSWORD: 'p', MT_PORT: '443', MT_SNI: 'a.ru' },
      output: 'tg://proxy?server=1.1.1.1&port=443&secret=ee00',
    });
    const list = Array.isArray(out) ? out : out ? [out] : [];
    expect(list.map((e) => e.kind)).toEqual(['mtproxyl-panel']);
  });
});

describe('индексирование', () => {
  it('robots.txt запрещает всё, X-Robots-Tag на ответах панели', async () => {
    const r = await built.app.inject({ method: 'GET', url: '/robots.txt' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('Disallow: /');
    const h = await built.app.inject({ method: 'GET', url: '/api/health' });
    expect(h.headers['x-robots-tag']).toContain('noindex');
  });
});

describe('команды OpenFlux', () => {
  it('в каталоге, имя канала и ссылки документов проверяются', () => {
    const c = findCommand('openflux');
    expect(c?.service).toBe('OpenFlux');
    expect(findCommand('openflux-uninstall')?.group).toBe('maintain');
    const ok = { OF_CHANNEL: 'main', OF_CUPS: 'yes', OF_AUTOUPDATE: 'yes' };
    expect(c && validateAnswers(c, ok)).toEqual([]);
    expect(c && validateAnswers(c, { ...ok, OF_CHANNEL: 'Main!' }).length).toBe(1);
    expect(c && validateAnswers(c, { ...ok, OF_VYANDEX: 'https://evil.example/x' }).length).toBe(1);
    expect(c?.script).toContain('sha256sum -c');
  });
});
