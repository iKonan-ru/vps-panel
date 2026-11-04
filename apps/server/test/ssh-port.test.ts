import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshPortChangeSchema } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { portsyncConfigs, servers } from '../src/db/schema.js';
import { changeSshPort } from '../src/lib/ssh-port.js';
import { sshRun } from '../src/lib/ssh.js';

vi.mock('../src/lib/ssh.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/ssh.js')>()),
  sshRun: vi.fn(),
}));
let dir: string;
let db: ReturnType<typeof createDb>;
let request: ReturnType<typeof vi.fn>;
let calls: string[];
const token = 'a'.repeat(32);
const prepared = { token, port: 24567, oldPorts: [22], fingerprints: ['SHA256:known'] };
const body = { port: 24567, externalFirewallReady: true } as const;
const row = () => db.select().from(servers).where(eq(servers.id, 's')).get();
const change = (input = body) =>
  changeSshPort(
    {
      db,
      env: loadEnv({ NODE_ENV: 'test', DATA_DIR: dir }),
      registry: { request } as unknown as AgentRegistry,
    },
    's',
    input,
    () => {},
  );

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ssh-port-test-'));
  db = createDb(':memory:');
  db.insert(servers)
    .values({ id: 's', name: 'server', host: '203.0.113.10', hostKeyFingerprint: 'SHA256:known' })
    .run();
  calls = [];
  request = vi.fn(async (_id, method) => {
    calls.push(method);
    if (method === 'ssh.port.prepare') return prepared;
    if (method === 'ssh.port.commit') expect(row()?.sshPort).toBe(22);
    if (method === 'ssh.port.finish') expect(row()?.sshPort).toBe(24567);
    return { ok: true };
  });
  vi.mocked(sshRun)
    .mockReset()
    .mockImplementation(async (target) => {
      calls.push('ssh');
      expect(target.port).toBe(24567);
      expect(target.fingerprints).toEqual(['SHA256:known']);
      expect(target.knownFingerprint).toBe('SHA256:known');
      expect(row()?.sshPort).toBe(22);
      return { exitCode: 0, fingerprint: 'SHA256:known' };
    });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('безопасная смена SSH-порта', () => {
  it('сначала проверяет вход, затем сохраняет порт и закрывает прежний', async () => {
    await change();
    expect(calls).toEqual(['ssh.port.prepare', 'ssh', 'ssh.port.commit', 'ssh.port.finish']);
    expect(row()?.sshPort).toBe(24567);
  });
  it('сохраняет порт в настройках port-sync', async () => {
    db.insert(portsyncConfigs)
      .values({ serverId: 's', config: { ssh_port: 22, admin_ips: [] } as never })
      .run();
    await change();
    expect(db.select().from(portsyncConfigs).get()?.config.ssh_port).toBe(24567);
  });
  it.each(['firewall не пропускает соединение', 'ключ хоста не совпал', 'ключ панели не принят'])(
    'откатывает при отказе: %s',
    async (message) => {
      vi.mocked(sshRun).mockRejectedValueOnce(new Error(message));
      await expect(change()).rejects.toThrow(message);
      expect(calls).toEqual(['ssh.port.prepare', 'ssh.port.rollback']);
      expect(row()?.sshPort).toBe(22);
    },
  );
  it('не сохраняет порт при ненулевом результате SSH', async () => {
    vi.mocked(sshRun).mockResolvedValueOnce({ exitCode: 1, fingerprint: 'SHA256:known' });
    await expect(change()).rejects.toThrow('не прошёл');
    expect(row()?.sshPort).toBe(22);
    expect(calls).toContain('ssh.port.rollback');
  });
  it('потеря ответа commit сохраняет старую запись и запрашивает безопасное восстановление обоих путей', async () => {
    request.mockImplementation(async (_id, method) => {
      calls.push(method);
      if (method === 'ssh.port.prepare') return prepared;
      if (method === 'ssh.port.commit') throw new Error('ответ потерян');
      return { ok: true };
    });
    await expect(change()).rejects.toThrow('ответ потерян');
    expect(row()?.sshPort).toBe(22);
    expect(calls.at(-1)).toBe('ssh.port.rollback');
  });
  it('ошибка завершения сохраняет проверенный порт в базе', async () => {
    request.mockImplementation(async (_id, method) => {
      calls.push(method);
      if (method === 'ssh.port.prepare') return prepared;
      if (method === 'ssh.port.finish') throw new Error('перезагрузка не удалась');
      return { ok: true };
    });
    await expect(change()).rejects.toThrow('не удалась');
    expect(row()?.sshPort).toBe(24567);
    expect(calls).not.toContain('ssh.port.rollback');
  });
  it('занятый порт не запускает проверку SSH и не меняет базу', async () => {
    request.mockRejectedValueOnce(new Error('порт занят'));
    await expect(change()).rejects.toThrow('порт занят');
    expect(sshRun).not.toHaveBeenCalled();
    expect(row()?.sshPort).toBe(22);
  });
  it('отклоняет диапазон и отсутствие подтверждения внешнего firewall', () => {
    for (const port of [0, 1, 1023, 65536, 1.5])
      expect(SshPortChangeSchema.safeParse({ ...body, port }).success).toBe(false);
    for (const port of [22, 1024, 65535])
      expect(SshPortChangeSchema.safeParse({ ...body, port }).success).toBe(true);
    expect(SshPortChangeSchema.safeParse({ port: 24567 }).success).toBe(false);
  });
});
