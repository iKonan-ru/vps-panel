import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { initAdmin } from '../src/lib/auth.js';

// каталог данных - временный: маршруты создают в нём backups/ (с ':memory:' - в рабочей копии)
const dir = mkdtempSync(join(tmpdir(), 'vps-auth-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
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

  it('no browser wizard: the admin comes from the console, 2FA is set up at first login', async () => {
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
    expect(res.statusCode).toBe(404);

    const created = await initAdmin(db, 'admin');
    expect(created?.password).toMatch(/^[A-Za-z0-9]{20}$/);
    expect(await initAdmin(db, 'other')).toBeNull();
    const password = must(created?.password);

    // first login: password -> new secret with backup codes -> first code enables 2FA
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'admin', password },
    });
    expect(res.json().next).toBe('enroll');
    const { totpSecret, backupCodes } = res.json();
    expect(backupCodes).toHaveLength(8);
    let pend = must(cookiesOf(res).vps_pending);
    // the totp step does not accept a code before 2FA is enrolled
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      cookies: { vps_pending: pend },
      payload: { code: authenticator.generate(totpSecret) },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/enroll',
      cookies: { vps_pending: pend },
      payload: { code: '000000' },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/enroll',
      cookies: { vps_pending: pend },
      payload: { code: authenticator.generate(totpSecret) },
    });
    expect(res.statusCode).toBe(200);
    const session = must(cookiesOf(res).vps_session);
    res = await app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { vps_session: session },
    });
    expect(res.json().login).toBe('admin');

    // next login: password then totp (a backup code works too)
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'admin', password: 'wrong' },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'admin', password },
    });
    expect(res.json()).toEqual({ next: 'totp' });
    pend = must(cookiesOf(res).vps_pending);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/enroll',
      cookies: { vps_pending: pend },
      payload: { code: authenticator.generate(totpSecret) },
    });
    expect(res.statusCode).toBe(401);
    res = await app.inject({
      method: 'POST',
      url: '/api/auth/totp',
      cookies: { vps_pending: pend },
      payload: { code: must(backupCodes[0]) },
    });
    expect(res.statusCode).toBe(200);
    expect(cookiesOf(res).vps_session).toBeTruthy();
  });
});
