import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { authenticator } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { findCommand, validateAnswers } from '../src/commands/index.js';
import type { CommandDef } from '../src/commands/types.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, firewallRules, servers, settings } from '../src/db/schema.js';
import { createAdmin, createSession } from '../src/lib/auth.js';
import { redactOutput } from '../src/lib/redact.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { Telegram } from '../src/lib/telegram.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-sec-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
const db = createDb(':memory:');
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let cookie = '';

beforeAll(async () => {
  ({ app } = await buildApp({ env, db }));
  await app.ready();
  const a = await createAdmin(db, 'admin', 'password-123');
  cookie = `vps_session=${(await createSession(db, a.id, '127.0.0.1', 'test')).token}`;
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('Origin', () => {
  it('rejects a state-changing request from another page of the same site', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, host: 'panel.example.com', origin: 'https://sub.example.com' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('lets the panel own page and non-browser clients through', async () => {
    for (const origin of ['https://panel.example.com', undefined]) {
      // выход гасит сессию: каждому запросу - своя
      const own = await createSession(
        db,
        (await createAdmin(db, `o${origin}`, 'p-123456')).id,
        '',
        '',
      );
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: {
          cookie: `vps_session=${own.token}`,
          host: 'panel.example.com',
          ...(origin ? { origin } : {}),
        },
      });
      expect(res.statusCode, String(origin)).toBe(200);
    }
  });
});

describe('backup upload', () => {
  it('rejects an unknown token before reading the body', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/agent/backups/upload/nope',
      headers: { 'content-type': 'text/plain', authorization: 'Bearer nope' },
      payload: 'x'.repeat(1024 * 1024),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('firewall rule source', () => {
  it('accepts only any, an IP or a subnet', async () => {
    const own = await createSession(
      db,
      (await createAdmin(db, 'fw', 'password-123')).id,
      '127.0.0.1',
      't',
    );
    for (const source of ['1.2.3.4; reboot', '1.2.3.4/33', 'example.com', '1.2.3.4/24/1']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers/nope/firewall/rules',
        headers: { cookie: `vps_session=${own.token}` },
        payload: { portFrom: 443, source },
      });
      expect(res.statusCode, source).toBe(400);
    }
  });
});

describe('firewall rules', () => {
  it('are written to the database only after the server applied them', async () => {
    db.insert(servers)
      .values({ id: 'fw1', name: 'fw1', host: '1.1.1.9' } as never)
      .run();
    const own = await createSession(db, (await createAdmin(db, 'fw2', 'p-123456')).id, '', '');
    const res = await app.inject({
      method: 'POST',
      url: '/api/servers/fw1/firewall/rules',
      cookies: { vps_session: own.token },
      payload: { portFrom: 8443 },
    });
    expect(res.statusCode).toBe(409);
    expect(db.select().from(firewallRules).all()).toEqual([]);
  });
});

describe('public client pages', () => {
  it('limit 30 requests a minute per address', async () => {
    const url = `/sub/${'0'.repeat(32)}`;
    const codes: number[] = [];
    for (let i = 0; i < 31; i++) codes.push((await app.inject({ method: 'GET', url })).statusCode);
    expect(codes.slice(0, 30).every((c) => c === 404)).toBe(true);
    expect(codes[30]).toBe(429);
  });
});

describe('redactOutput', () => {
  it('hides known secrets and proxy link secrets', () => {
    const out = redactOutput(
      'pass: hunter22\ntg://proxy?server=1.2.3.4&port=443&secret=ee0011aabb\nport 1\n',
      ['hunter22', '1'],
    );
    expect(out).not.toContain('hunter22');
    expect(out).not.toContain('ee0011aabb');
    expect(out).toContain('secret=********');
    expect(out).toContain('port 1');
  });

  it('токен API, который печатает установщик 3X-UI, в журнал не попадает', () => {
    const out = redactOutput(
      '\x1b[0;32mAPI Token:   QKBcfHN47VPkpzsp7AKx\x1b[0m\napi_token=abc123def456\nPort: 47016\n',
      [],
    );
    expect(out).not.toContain('QKBcfHN47VPkpzsp7AKx');
    expect(out).not.toContain('abc123def456');
    expect(out).toContain('API Token:   ********\x1b[0m');
    expect(out).toContain('Port: 47016');
  });

  it('скрипт 3X-UI маскирует пароль и токен в выводе установщика', () => {
    const s = findCommand('xui')?.script ?? '';
    expect(s).toMatch(/xui-install\.sh <\/dev\/null 2>&1 \| sed -u -E .*Password\|API Token/);
    // токен установщика ("install") перевыпускается с выбросом вывода, файл итога удаляется
    expect(s).toContain('x-ui setting -getApiToken -tokenName install >/dev/null');
    expect(s).toContain('rm -f /etc/x-ui/install-result.env');
  });
});

describe('catalog answers', () => {
  it('check domain names', () => {
    const c = {
      params: [{ name: 'D', label: 'Домен', type: 'domain' }],
    } as unknown as CommandDef;
    expect(validateAnswers(c, { D: 'sub.example.com' })).toEqual([]);
    for (const D of ['example', 'a b.com', 'x.com; reboot', '-x.com'])
      expect(validateAnswers(c, { D }), D).toHaveLength(1);
  });
});

describe('login after 2FA reset from the console', () => {
  it('sets up a new secret at login and enables 2FA with its first code', async () => {
    const a = await createAdmin(db, 'half', 'password-123');
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: 'half', password: 'password-123' },
      remoteAddress: '10.0.0.9',
    });
    expect(login.json().next).toBe('enroll');
    const pending = login.cookies.find((c) => c.name !== 'vps_session');
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/enroll',
      payload: { code: authenticator.generate(login.json().totpSecret) },
      cookies: { [pending?.name ?? '']: pending?.value ?? '' },
      remoteAddress: '10.0.0.9',
    });
    expect(res.statusCode).toBe(200);
    expect(db.select().from(admins).where(eq(admins.id, a.id)).get()?.totpEnabled).toBe(true);
  });
});

describe('agent channel v1', () => {
  // регистрация и вход - только v2 (agent-ws-v2.test.ts)
  it('is refused even with a valid-looking token', async () => {
    const ws = await app.injectWS('/ws/agent', { headers: { authorization: 'Bearer reg:x' } });
    const code = await new Promise<number>((resolve) => ws.on('close', (c) => resolve(c)));
    expect(code).toBe(4006);
  });
});

describe('telegram bot token', () => {
  it('is sealed in the database', async () => {
    const mem = createDb(':memory:');
    const box = new SecretBox('x'.repeat(32));
    const log = { info: () => undefined, warn: () => undefined };
    const n = new Telegram(mem, box, {} as never, log);
    const stored = () =>
      mem.select().from(settings).where(eq(settings.key, 'tg_token')).get()?.value;
    await n.save({ token: '456:new' });
    expect(stored()).toMatch(/^v1:/);
    expect((await n.settings()).token).toBe('456:new');
  });
});
