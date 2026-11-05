import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { createAdmin, createSession, saveTotp } from '../src/lib/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-audit-dyn-'));
const env = loadEnv({
  NODE_ENV: 'test',
  DATA_DIR: dir,
  PANEL_PUBLIC_URL: 'https://panel.example',
  SUB_DOMAIN: 'sub.panel.example',
});
const db = createDb(':memory:');
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let port = 0;
let adminId = '';
let session = '';

const inventory = {
  services: [
    { kind: 'xui', title: '3X-UI', ports: [], panelUrl: 'https://1.2.3.4:2053/secretpath/' },
  ],
};

beforeAll(async () => {
  ({ app } = await buildApp({ env, db }));
  await app.ready();
  const a = await createAdmin(db, 'audit', 'password-123');
  adminId = a.id;
  session = (await createSession(db, adminId, '127.0.0.1', 'audit')).token;
  const addr = await app.listen({ port: 0, host: '127.0.0.1' });
  port = Number(new URL(addr).port);
  db.insert(servers)
    .values({ id: 's1', name: 'NetCore', host: '1.2.3.4', statusCache: { inventory } } as never)
    .run();
});

afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

function subdomainGet(host: string, path: string, headers: Record<string, string> = {}) {
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

const cookie = () => `__Host-vps_session=${session}`;

describe('audit dynamic checks', () => {
  it('backup settings/download require step-up', async () => {
    const noStep = await app.inject({
      method: 'POST',
      url: '/api/panel-backup/settings',
      headers: { cookie: cookie() },
      payload: { password: 'audit-password-123' },
    });
    expect(noStep.statusCode).toBe(403);
    expect(noStep.json().code).toBe('step_up_required');

    const su = await app.inject({
      method: 'POST',
      url: '/api/auth/step-up',
      headers: { cookie: cookie() },
      payload: { password: 'password-123' },
    });
    expect(su.statusCode).toBe(200);
    const step = su.cookies.find((c) => c.name.endsWith('vps_stepup'));
    expect(step).toBeTruthy();
    const headers = { cookie: `${cookie()}; ${step?.name}=${step?.value}` };

    const set = await app.inject({
      method: 'POST',
      url: '/api/panel-backup/settings',
      headers,
      payload: { password: 'audit-password-123' },
    });
    expect(set.statusCode).toBe(200);
    const dl = await app.inject({
      method: 'GET',
      url: '/api/panel-backup/download',
      headers,
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.rawPayload.subarray(0, 6).toString()).toBe('VPSBK2');
  });

  it('TOTP step has no 5-failure lockout', async () => {
    const secret = authenticator.generateSecret();
    await saveTotp(db, adminId, secret, ['0123456789']);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'audit', password: 'password-123' },
      remoteAddress: '10.0.0.10',
    });
    expect(login.statusCode).toBe(200);
    const pending = login.cookies.find((c) => c.name.endsWith('vps_pending'));
    expect(pending).toBeTruthy();
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/totp',
        payload: { code: '000000' },
        cookies: { [pending?.name ?? 'vps_pending']: pending?.value ?? '' },
        remoteAddress: '10.0.0.10',
      });
      codes.push(res.statusCode);
    }
    expect(codes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(codes[5]).toBe(429);
  });

  it('proxy back accepts a backslash path that resolves off-site', async () => {
    const open = await app.inject({
      method: 'GET',
      url: '/api/proxy/open/netcore-xui?go=1&back=%2F%5Cevil.com',
      headers: { cookie: cookie() },
    });
    expect(open.statusCode).toBe(302);
    const loc = new URL(String(open.headers.location));
    const t = loc.searchParams.get('t');
    expect(t).toBeTruthy();
    const auth = await subdomainGet(
      'netcore-xui.panel.example',
      `/__vps/auth?t=${encodeURIComponent(t ?? '')}&back=%2F%5Cevil.com`,
    );
    expect(auth.status).toBe(302);
    expect(auth.headers.location).toBe('/secretpath/');
  });
});
