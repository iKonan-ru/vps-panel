import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, trustCaddy } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, loginAttempts } from '../src/db/schema.js';
import {
  DockerRef,
  MtproxylArgs,
  PortsyncConfig,
  SshPublicKey,
  WgKey,
} from '../src/lib/validate.js';
import { OPEN_API } from '../src/routes/auth.js';

// Атомарный мастер, trustProxy, явный список открытых маршрутов, проверки параметров
const dir = mkdtempSync(join(tmpdir(), 'vps-a9-'));
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

describe('мастер первой настройки', () => {
  it('два параллельных запроса создают одного администратора', async () => {
    const setup = (login: string) =>
      app.inject({
        method: 'POST',
        url: '/api/setup',
        payload: { login, password: 'password-1234' },
      });
    const codes = (await Promise.all([setup('first'), setup('second'), setup('third')]))
      .map((r) => r.statusCode)
      .sort();
    expect(codes).toEqual([200, 409, 409]);
    expect(db.select().from(admins).all()).toHaveLength(1);
  });
});

describe('trustProxy', () => {
  it('IP клиента - адрес, дописанный Caddy, а не подставленный слева', async () => {
    await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: '172.18.0.3',
      headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
      payload: { login: 'nobody', password: 'wrong-password' },
    });
    const ips = db
      .select()
      .from(loginAttempts)
      .all()
      .map((r) => r.ip);
    expect(ips).toContain('5.6.7.8');
    expect(ips).not.toContain('1.2.3.4');
  });

  it('прямой заход не из сети docker: заголовок не учитывается', () => {
    expect(trustCaddy('172.18.0.3', 0)).toBe(true);
    expect(trustCaddy('::ffff:10.0.0.2', 0)).toBe(true);
    expect(trustCaddy('8.8.8.8', 0)).toBe(false);
    expect(trustCaddy('10.0.0.2', 1)).toBe(false);
  });
});

describe('маршруты без входа', () => {
  it('каждый из списка существует (опечатка открыла бы не тот маршрут)', () => {
    const routes = app.printRoutes({ commonPrefix: false });
    for (const url of OPEN_API) {
      const last = url.split('/').filter(Boolean).at(-1) ?? '';
      expect(routes, url).toContain(last);
    }
  });

  it('новый маршрут под /api/agent/ закрыт входом', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/rollout' });
    expect(res.statusCode).toBe(401);
  });
});

describe('параметры для агента', () => {
  it('контейнер docker', () => {
    expect(DockerRef.safeParse('amnezia-awg').success).toBe(true);
    expect(DockerRef.safeParse('3f2a9c1b0d4e').success).toBe(true);
    for (const bad of ['-rm', 'a b', 'a;b', '', 'x'.repeat(200)])
      expect(DockerRef.safeParse(bad).success, bad).toBe(false);
  });

  it('ключи', () => {
    expect(WgKey.safeParse('yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=').success).toBe(true);
    expect(WgKey.safeParse('yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBm=').success).toBe(false);
    expect(SshPublicKey.safeParse('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA me@host').success).toBe(
      true,
    );
    expect(SshPublicKey.safeParse('ssh-ed25519 AAAA\ncommand="x" ssh-rsa AAAA').success).toBe(
      false,
    );
    expect(SshPublicKey.safeParse('command="rm" ssh-ed25519 AAAA').success).toBe(false);
  });

  it('аргументы MTProxyL', () => {
    expect(MtproxylArgs.safeParse({ label: 'anna_1', secret: '' }).success).toBe(true);
    expect(MtproxylArgs.safeParse({ version: 'v3.3.1' }).success).toBe(true);
    expect(MtproxylArgs.safeParse({ label: '--all' }).success).toBe(false);
    expect(MtproxylArgs.safeParse({ secret: 'zz' }).success).toBe(false);
    expect(MtproxylArgs.safeParse({ cmd: 'x' }).success).toBe(false);
  });

  it('конфиг port-sync', () => {
    const ok = PortsyncConfig.safeParse({
      admin_ips: ['1.2.3.4', '10.0.0.0/8', '2001:db8::/32'],
      deny_public_ports: ['2053', '8443/tcp'],
      wan_interface: 'eth0',
    });
    expect(ok.success).toBe(true);
    for (const bad of [
      { admin_ips: ['1.2.3.4/33'] },
      { admin_ips: ['host'] },
      { extra_allow: ['70000'] },
      { deny_public_ports: ['443/sctp'] },
      { wan_interface: 'lo' },
      { known_processes: ['a b'] },
    ])
      expect(PortsyncConfig.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });
});
