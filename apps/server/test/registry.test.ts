import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMethodSchema } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { AGENT_OUTDATED, AgentRegistry } from '../src/agents/registry.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { access, actionLog, servers } from '../src/db/schema.js';
import { createAdmin, createSession } from '../src/lib/auth.js';
import { SecretBox } from '../src/lib/secret-box.js';

/** Сокет агента: запросы панели складываются в sent, ответы агента - через reply(). */
class FakeWs extends EventEmitter {
  sent: { id: string; method: string }[] = [];
  closed: number | null = null;
  send(raw: string, cb?: (err?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    cb?.();
  }
  close(code: number) {
    this.closed = code;
    this.emit('close');
  }
  terminate() {
    this.close(1006);
  }
  ping() {}
  reply(msg: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}

function connect(reg: AgentRegistry, serverId = 's1') {
  const ws = new FakeWs();
  reg.attach({ serverId, ws: ws as never, methods: AgentMethodSchema.options });
  return ws;
}

describe('AgentRegistry.request', () => {
  it('returns the result and routes the stream to its request', async () => {
    const reg = new AgentRegistry();
    const ws = connect(reg);
    const chunks: string[] = [];
    const p = reg.request(
      's1',
      'inventory.get',
      {},
      { onStream: (_c, chunk) => chunks.push(chunk) },
    );
    const id = ws.sent[0]?.id;
    ws.reply({ type: 'stream', id, channel: 'stdout', chunk: 'a' });
    ws.reply({ type: 'result', id, ok: true, data: { x: 1 } });
    await expect(p).resolves.toEqual({ x: 1 });
    expect(chunks).toEqual(['a']);
    ws.close(1000);
  });

  it('rejects with the agent error text', async () => {
    const reg = new AgentRegistry();
    const ws = connect(reg);
    const p = reg.request('s1', 'inventory.get');
    ws.reply({ type: 'result', id: ws.sent[0]?.id, ok: false, error: 'нет такого' });
    await expect(p).rejects.toMatchObject({ message: 'нет такого', statusCode: 502 });
    ws.close(1000);
  });

  it('times out and fails at once when the agent is offline', async () => {
    const reg = new AgentRegistry();
    await expect(reg.request('s1', 'inventory.get')).rejects.toMatchObject({
      message: 'Агент не подключён',
      statusCode: 409,
    });
    const ws = connect(reg);
    await expect(reg.request('s1', 'inventory.get', {}, { timeoutMs: 20 })).rejects.toThrow(
      'Агент не ответил вовремя',
    );
    ws.close(1000);
  });

  it('rejects pending requests when the agent disconnects', async () => {
    const reg = new AgentRegistry();
    const ws = connect(reg);
    const p = reg.request('s1', 'inventory.get');
    ws.close(1006);
    await expect(p).rejects.toThrow('Агент отключился');
    expect(reg.isOnline('s1')).toBe(false);
  });

  it('a new connection replaces the old one, closing the old does not drop the new', async () => {
    const reg = new AgentRegistry();
    const old = connect(reg);
    const fresh = connect(reg);
    expect(old.closed).toBe(4000);
    expect(reg.isOnline('s1')).toBe(true);
    const p = reg.request('s1', 'inventory.get');
    expect(fresh.sent).toHaveLength(1);
    fresh.reply({ type: 'result', id: fresh.sent[0]?.id, ok: true, data: 1 });
    await expect(p).resolves.toBe(1);
    fresh.close(1000);
  });
});

describe('AgentRegistry: operations the agent does not know', () => {
  it('are refused by the list from hello without a request', async () => {
    const reg = new AgentRegistry();
    const ws = new FakeWs();
    reg.attach({ serverId: 's1', ws: ws as never, methods: ['inventory.get'] });
    expect(reg.supports('s1', 'inventory.get')).toBe(true);
    expect(reg.supports('s1', 'awg.status')).toBe(false);
    await expect(reg.request('s1', 'awg.status')).rejects.toMatchObject({
      message: AGENT_OUTDATED,
      statusCode: 409,
    });
    expect(ws.sent).toHaveLength(0);
    ws.close(1000);
  });

  it('an old agent without the list answers "not supported" - the same error', async () => {
    const reg = new AgentRegistry();
    const ws = connect(reg);
    expect(reg.supports('s1', 'awg.status')).toBe(true);
    const p = reg.request('s1', 'awg.status');
    ws.reply({
      type: 'result',
      id: ws.sent[0]?.id,
      ok: false,
      error: 'метод пока не поддерживается: awg.status',
    });
    await expect(p).rejects.toMatchObject({ message: AGENT_OUTDATED, statusCode: 409 });
    ws.close(1000);
  });
});

describe('AgentRegistry: snapshot with Go nil slices', () => {
  it('takes null lists as empty instead of dropping the snapshot', () => {
    const reg = new AgentRegistry();
    const ws = connect(reg);
    const got: { services: unknown[]; firewall: { rules: unknown[] }; certs: unknown[] }[] = [];
    reg.on('inventory', (_id, inv) => got.push(inv));
    reg.on('invalid', (_id, err) => {
      throw new Error(err);
    });
    ws.reply({
      type: 'inventory',
      inventory: {
        host: { hostname: 'h', os: 'Ubuntu', kernel: '6', arch: 'amd64', agentVersion: '0.2.0' },
        services: null,
        containers: null,
        firewall: {
          ufwActive: true,
          defaultIncoming: 'deny',
          portsyncInstalled: true,
          portsyncActive: true,
          dockerFiltered: true,
          rules: null,
          listeners: null,
        },
        audit: {
          sshPort: 22,
          sshPasswordAuth: false,
          sshPermitRootLogin: 'prohibit-password',
          fail2banRunning: true,
          fail2banJails: null,
          jails: null,
          unattendedUpgrades: true,
          pendingUpdates: 0,
          rebootRequired: false,
          findings: null,
        },
        certs: null,
        collectedAt: '2026-10-04T00:00:00Z',
      },
    });
    expect(got).toHaveLength(1);
    expect(got[0]?.services).toEqual([]);
    expect(got[0]?.firewall.rules).toEqual([]);
    expect(got[0]?.certs).toEqual([]);
    ws.close(1000);
  });
});

describe('AgentRegistry: messages that fail the schema', () => {
  it('are reported with the field, not dropped silently', () => {
    const reg = new AgentRegistry();
    const ws = connect(reg);
    const got: string[] = [];
    reg.on('invalid', (id, err) => got.push(`${id} ${err}`));
    ws.reply({ type: 'metrics', metrics: null });
    expect(got).toHaveLength(1);
    expect(got[0]).toMatch(/^s1 metrics: /);
    ws.close(1000);
  });
});

describe('SecretBox', () => {
  const box = new SecretBox('x'.repeat(32));
  it('round-trips and never repeats the ciphertext', () => {
    const a = box.seal('пароль');
    expect(a).toMatch(/^v1:/);
    expect(box.seal('пароль')).not.toBe(a);
    expect(box.open(a)).toBe('пароль');
  });

  it('rejects a tampered value and a value sealed with another key', () => {
    const a = box.seal('secret');
    const raw = Buffer.from(a.slice(3), 'base64');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => box.open(`v1:${raw.toString('base64')}`)).toThrow();
    expect(() => new SecretBox('y'.repeat(32)).open(a)).toThrow();
  });

  it('passes old plain values through', () => {
    expect(box.open('plain')).toBe('plain');
  });
});

describe('agent errors in routes', () => {
  it('reach the page with their text and a 5xx code, not as an internal error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-agent-err-'));
    const db = createDb(':memory:');
    const reg = new AgentRegistry();
    const { app } = await buildApp({
      env: loadEnv({ NODE_ENV: 'test', DATA_DIR: dir }),
      db,
      registry: reg,
    });
    try {
      await app.ready();
      db.insert(servers)
        .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
        .run();
      const ws = connect(reg);
      ws.send = (raw: string, cb?: (err?: Error) => void) => {
        cb?.();
        const { id } = JSON.parse(raw);
        setImmediate(() =>
          ws.reply({ type: 'result', id, ok: false, error: 'wdtt не установлен' }),
        );
      };
      const a = await createAdmin(db, 'admin', 'password-123');
      const { token } = await createSession(db, a.id, '', '');
      const res = await app.inject({
        method: 'GET',
        url: '/api/servers/s1/wdtt',
        cookies: { vps_session: token },
      });
      expect(res.statusCode).toBe(502);
      expect(res.json().error).toBe('wdtt не установлен');
      ws.close(1000);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('command run through the agent', () => {
  it('streams the output and writes it to the journal without secrets', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-cmd-'));
    const db = createDb(':memory:');
    const reg = new AgentRegistry();
    const { app } = await buildApp({
      env: loadEnv({ NODE_ENV: 'test', DATA_DIR: dir }),
      db,
      registry: reg,
    });
    try {
      await app.ready();
      db.insert(servers)
        .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
        .run();
      const ws = connect(reg);
      ws.send = (raw: string, cb?: (err?: Error) => void) => {
        cb?.();
        const { id, method } = JSON.parse(raw);
        if (method !== 'command.run') return;
        setImmediate(() => {
          ws.reply({
            type: 'stream',
            id,
            channel: 'stdout',
            chunk: 'link tg://proxy?secret=ee0011\n',
          });
          ws.reply({ type: 'result', id, ok: true, data: { exitCode: 0, killed: false } });
        });
      };
      const a = await createAdmin(db, 'admin', 'password-123');
      const { token } = await createSession(db, a.id, '', '');
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers/s1/commands/xui-uninstall/run',
        cookies: { vps_session: token },
        payload: { CONFIRM: 'yes' },
      });
      expect(res.statusCode).toBe(200);
      const { actionId } = res.json();
      await new Promise((r) => setTimeout(r, 50));
      const row = db
        .select()
        .from(actionLog)
        .all()
        .find((r) => r.id === actionId);
      expect(row?.exitCode).toBe(0);
      expect(row?.output).toContain('secret=********');
      expect(row?.output).not.toContain('ee0011');
      ws.close(1000);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('3X-UI installed again', () => {
  it('forgets the old API token: the new database does not know it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vps-xui-token-'));
    const db = createDb(':memory:');
    const reg = new AgentRegistry();
    const { app } = await buildApp({
      env: loadEnv({ NODE_ENV: 'test', DATA_DIR: dir }),
      db,
      registry: reg,
    });
    try {
      await app.ready();
      db.insert(servers)
        .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
        .run();
      db.insert(access)
        .values({
          id: 'a1',
          serverId: 's1',
          kind: 'xui-api',
          title: 'API 3X-UI',
          fields: [],
        } as never)
        .run();
      const ws = connect(reg);
      ws.send = (raw: string, cb?: (err?: Error) => void) => {
        cb?.();
        const { id, method } = JSON.parse(raw);
        if (method === 'command.run')
          setImmediate(() =>
            ws.reply({ type: 'result', id, ok: true, data: { exitCode: 0, killed: false } }),
          );
      };
      const a = await createAdmin(db, 'admin', 'password-123');
      const { token } = await createSession(db, a.id, '', '');
      const res = await app.inject({
        method: 'POST',
        url: '/api/servers/s1/commands/xui/run',
        cookies: { vps_session: token },
        payload: {
          XUI_USERNAME: 'admin',
          XUI_PASSWORD: 'pass-1234567890',
          XUI_PANEL_PORT: '23456',
          XUI_WEB_BASE_PATH: '/abcdef/',
          XUI_SSL_MODE: 'none',
        },
      });
      expect(res.statusCode, res.body).toBe(200);
      await new Promise((r) => setTimeout(r, 50));
      const kinds = db
        .select()
        .from(access)
        .all()
        .map((r) => r.kind);
      expect(kinds).toEqual(['xui']);
      ws.close(1000);
    } finally {
      await app.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
