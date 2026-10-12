import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { createAdmin, createSession, saveTotp, sha256 } from '../src/lib/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-account-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
const db = createDb(':memory:');
let app: Awaited<ReturnType<typeof buildApp>>['app'];
const secret = authenticator.generateSecret();
let adminId = '';
let token = '';
let other = '';

beforeAll(async () => {
  ({ app } = await buildApp({ env, db }));
  await app.ready();
  adminId = (await createAdmin(db, 'admin', 'old-password-1')).id;
  await saveTotp(db, adminId, secret, ['1111111111']);
  token = (await createSession(db, adminId, '10.0.0.1', 'test')).token;
  other = (await createSession(db, adminId, '10.0.0.2', 'phone')).token;
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = (
  method: 'GET' | 'PUT' | 'POST' | 'DELETE',
  url: string,
  payload?: object,
  t = token,
) =>
  app.inject({
    method,
    url,
    cookies: { vps_session: t },
    ...(payload ? { payload } : {}),
    remoteAddress: '10.0.0.7',
  });

describe('аккаунт', () => {
  it('сводка без входа закрыта', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/account' })).statusCode).toBe(401);
    const r = await call('GET', '/api/account');
    expect(r.json()).toMatchObject({ login: 'admin', totpEnabled: true, backupCodesLeft: 1 });
  });

  it('логин: только с текущим паролем и по правилам', async () => {
    expect(
      (await call('PUT', '/api/account/login', { login: 'boss', password: 'nope' })).statusCode,
    ).toBe(400);
    expect(
      (await call('PUT', '/api/account/login', { login: 'a b', password: 'old-password-1' }))
        .statusCode,
    ).toBe(400);
    const r = await call('PUT', '/api/account/login', {
      login: 'boss',
      password: 'old-password-1',
    });
    expect(r.json()).toEqual({ ok: true, login: 'boss' });
    expect((await call('GET', '/api/auth/me')).json().login).toBe('boss');
  });

  it('пароль: не короче 12, другие сессии закрываются, эта остаётся', async () => {
    expect(
      (
        await call('PUT', '/api/account/password', {
          password: 'old-password-1',
          newPassword: 'short',
        })
      ).statusCode,
    ).toBe(400);
    const r = await call('PUT', '/api/account/password', {
      password: 'old-password-1',
      newPassword: 'new-password-123',
    });
    expect(r.statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me')).statusCode).toBe(200);
    expect((await call('GET', '/api/auth/me', undefined, other)).statusCode).toBe(401);
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'boss', password: 'new-password-123' },
    });
    expect(login.json().next).toBe('totp');
  });

  it('новые резервные коды и перенастройка 2FA', async () => {
    const codes = (
      await call('POST', '/api/account/backup-codes', { password: 'new-password-123' })
    ).json().backupCodes as string[];
    expect(codes).toHaveLength(8);
    expect((await call('GET', '/api/account')).json().backupCodesLeft).toBe(8);

    expect(
      (await call('POST', '/api/account/totp', { password: 'new-password-123', code: '000000' }))
        .statusCode,
    ).toBe(400);
    const start = await call('POST', '/api/account/totp', {
      password: 'new-password-123',
      code: authenticator.generate(secret),
    });
    const fresh = start.json().totpSecret as string;
    expect(fresh).not.toBe(secret);
    expect((await call('POST', '/api/account/totp/confirm', { code: '000000' })).statusCode).toBe(
      400,
    );
    expect(
      (await call('POST', '/api/account/totp/confirm', { code: authenticator.generate(fresh) }))
        .statusCode,
    ).toBe(200);
    // старые резервные коды больше не действуют, новые - из перенастройки
    expect((await call('GET', '/api/account')).json().backupCodesLeft).toBe(8);
  });

  it('сессии: текущая помечена, чужую можно закрыть', async () => {
    const t2 = (await createSession(db, adminId, '10.0.0.3', 'tablet')).token;
    const list = (await call('GET', '/api/security')).json().sessions as {
      id: string;
      current: boolean;
    }[];
    expect(list.find((s) => s.current)?.id).toBe(sha256(token));
    const r = await call('DELETE', `/api/account/sessions/${sha256(t2)}`);
    expect(r.json()).toEqual({ ok: true, self: false });
    expect((await call('GET', '/api/auth/me', undefined, t2)).statusCode).toBe(401);
  });
});

describe('консоль: vps-panel admin', () => {
  const run = promisify(execFile);
  const data = mkdtempSync(join(tmpdir(), 'vps-cli-'));
  const cli = (...args: string[]) =>
    run('npx', ['tsx', '--conditions=development', 'src/cli.ts', ...args], {
      env: { ...process.env, DATA_DIR: data },
    });
  afterAll(() => rmSync(data, { recursive: true, force: true }));

  it('init, повторный init, сброс пароля и 2FA', { timeout: 60_000 }, async () => {
    const a = JSON.parse((await cli('admin-init')).stdout);
    expect(a.login).toMatch(/^admin-[a-z2-9]{6}$/);
    expect(a.password).toHaveLength(20);
    await expect(cli('admin-init', 'other')).rejects.toMatchObject({ code: 2 });
    await expect(cli('admin-login', 'a b')).rejects.toMatchObject({ code: 1 });
    expect(JSON.parse((await cli('admin-login', 'root-admin')).stdout)).toEqual({
      login: 'root-admin',
    });
    const p = JSON.parse((await cli('admin-password')).stdout);
    expect(p.login).toBe('root-admin');
    expect(p.password).not.toBe(a.password);
    expect(JSON.parse((await cli('admin-2fa')).stdout)).toEqual({ login: 'root-admin' });
    expect(JSON.parse((await cli('admin-show')).stdout)).toEqual({
      login: 'root-admin',
      totpEnabled: false,
      sessions: 0,
    });
  });
});

describe('панель без домена', () => {
  it('домен - только у имени, у IP его нет', async () => {
    const { panelDomain } = await import('../src/config.js');
    expect(panelDomain({ PANEL_PUBLIC_URL: 'https://panel.example.com' })).toBe(
      'panel.example.com',
    );
    expect(panelDomain({ PANEL_PUBLIC_URL: 'https://203.0.113.10' })).toBe('');
    expect(panelDomain({ PANEL_PUBLIC_URL: 'https://[2001:db8::1]' })).toBe('');
  });
});
