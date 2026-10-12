import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { createAdmin } from '../src/lib/auth.js';

// Панель на https: cookie входа с префиксом __Host- (поддомены панели не могут её подменить)
const dir = mkdtempSync(join(tmpdir(), 'vps-hostcookie-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir, PANEL_PUBLIC_URL: 'https://panel.example' });
const db = createDb(':memory:');
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp({ env, db }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('cookie __Host- на https', () => {
  it('вход выдаёт __Host- cookie с Secure, Path=/ и без Domain', async () => {
    await createAdmin(db, 'admin', 'correct horse battery');
    let res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'admin', password: 'correct horse battery' },
    });
    const pend = res.cookies.find((c) => c.name === '__Host-vps_pending');
    expect(pend?.secure).toBe(true);
    expect(pend?.path).toBe('/');
    expect(pend?.domain).toBeUndefined();
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/enroll',
      cookies: { '__Host-vps_pending': pend?.value ?? '' },
      payload: { code: authenticator.generate(res.json().totpSecret) },
    });
    const s = res.cookies.find((c) => c.name === '__Host-vps_session');
    expect(s?.secure).toBe(true);
    expect(s?.httpOnly).toBe(true);
    expect(s?.path).toBe('/');
    expect(s?.domain).toBeUndefined();
    const token = s?.value ?? '';

    res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { '__Host-vps_session': token },
    });
    expect(res.statusCode).toBe(200);
    // та же сессия под старым именем (так её мог бы подложить поддомен) не принимается
    res = await app.inject({ method: 'GET', url: '/api/auth/me', cookies: { vps_session: token } });
    expect(res.statusCode).toBe(401);

    // выход стирает cookie с Secure, иначе браузер не примет удаление __Host- cookie
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: { '__Host-vps_session': token },
    });
    const cleared = res.cookies.find((c) => c.name === '__Host-vps_session');
    expect(cleared?.secure).toBe(true);
    expect(cleared?.value).toBe('');
  });
});
