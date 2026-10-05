import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';

// каталог данных - временный: маршруты создают в нём backups/ (с ':memory:' - в рабочей копии)
const dir = mkdtempSync(join(tmpdir(), 'vps-auth-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp({ env, db: createDb(':memory:') }));
  await app.ready();
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function cookiesOf(res: { cookies: { name: string; value: string }[] }): Record<string, string> {
  return Object.fromEntries(res.cookies.map((c) => [c.name, c.value]));
}
function must(v: string | undefined): string {
  if (v === undefined) throw new Error('missing value');
  return v;
}

describe('setup and login', () => {
  it('health is public', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
  });

  it('protected routes need a session', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('percent-encoded path does not bypass the session check', async () => {
    for (const url of ['/%61pi/servers', '/%61%70%69/servers', '/api/%73ervers']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('agent checksum accepts only known arches', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/agent/checksum/x%2F..%2F..%2F..%2F..%2Fetc%2Fhostname',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown arch');
  });

  it('runs the first-start wizard and logs in with TOTP', async () => {
    let res: Awaited<ReturnType<typeof app.inject>> = await app.inject({
      method: 'GET',
      url: '/api/setup/status',
    });
    expect(res.json().setupDone).toBe(false);

    res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { login: 'admin', password: 'correct horse battery' },
    });
    expect(res.statusCode).toBe(200);
    const { totpSecret, backupCodes } = res.json();
    expect(backupCodes).toHaveLength(8);
    const pendingCookie = must(cookiesOf(res).vps_pending);

    res = await app.inject({
      method: 'POST',
      url: '/api/setup/confirm',
      cookies: { vps_pending: pendingCookie },
      payload: { code: authenticator.generate(totpSecret) },
    });
    expect(res.statusCode).toBe(200);
    const session = must(cookiesOf(res).vps_session);
    expect(session).toBeTruthy();

    res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { vps_session: session },
    });
    expect(res.json().login).toBe('admin');

    // second setup is refused
    res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { login: 'x', password: 'y'.repeat(12) },
    });
    expect(res.statusCode).toBe(409);

    // full login: password then totp
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'admin', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'admin', password: 'correct horse battery' },
    });
    expect(res.json().next).toBe('totp');
    const p2 = must(cookiesOf(res).vps_pending);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      cookies: { vps_pending: p2 },
      payload: { code: must(backupCodes[0]) },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiesOf(res).vps_session).toBeTruthy();
  });
});
