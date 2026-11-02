import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { actionLog, gclients, servers } from '../src/db/schema.js';
import { actionJournal } from '../src/lib/action-journal.js';
import type { ServerRouteOpts } from '../src/lib/action-runners.js';
import { getSetting } from '../src/lib/settings.js';
import { sshRun } from '../src/lib/ssh.js';
import { UiHub } from '../src/lib/ui-hub.js';
import type { UninstallLinks } from '../src/lib/uninstall-links.js';
import { uninstallRoutes } from '../src/routes/uninstall.js';

vi.mock('../src/lib/ssh.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/ssh.js')>()),
  sshRun: vi.fn(),
}));
vi.mock('../src/lib/panel-host.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/panel-host.js')>()),
  panelAddresses: async () => ['203.0.113.1'],
}));

const revision = 'a'.repeat(64);
const body = {
  confirmName: 'test',
  revision,
  ids: ['agent'],
  connectionsRevision: revision,
  password: 'new-test-password',
};
let app: FastifyInstance;
let dir: string;
let db: ReturnType<typeof createDb>;
let request: ReturnType<typeof vi.fn>;
let registry: AgentRegistry;
let hub: UiHub;
let links: Pick<UninstallLinks, 'plan' | 'lock' | 'detach'>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'vps-uninstall-test-'));
  db = createDb(':memory:');
  db.insert(servers).values({ id: 's', name: 'test', host: '203.0.113.20' }).run();
  request = vi.fn(async (_id, method) => {
    if (method === 'uninstall.scan')
      return { revision, panelHost: false, items: [], preserved: [], blockers: [] };
    if (method === 'uninstall.prepare')
      return { token: 'b'.repeat(32), fingerprints: ['SHA256:known'], port: 22 };
    return { ok: true };
  });
  registry = {
    isOnline: () => true,
    request,
    get: () => undefined,
    refreshInventory: async () => {},
  } as unknown as AgentRegistry;
  hub = new UiHub();
  vi.mocked(sshRun).mockReset().mockResolvedValue({ exitCode: 0, fingerprint: 'SHA256:known' });
  app = Fastify();
  app.setErrorHandler((error, _req, reply) => {
    const err = error as Error & { statusCode?: number };
    return reply.code(err.statusCode ?? 400).send({ error: err.message });
  });
  links = {
    plan: vi.fn(() => ({ revision, items: [], blockers: [] })),
    lock: vi.fn(() => async () => {}),
    detach: vi.fn(async () => {}),
  };
  await app.register(uninstallRoutes, {
    links: links as UninstallLinks,
    db,
    registry,
    hub,
    env: loadEnv({ NODE_ENV: 'test', DATA_DIR: dir }),
  } as ServerRouteOpts & { links: UninstallLinks });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function result() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/servers/s/uninstall',
    payload: body,
  });
  expect(response.statusCode).toBe(200);
  const id = response.json().actionId as string;
  await vi.waitFor(() => {
    expect(db.select().from(actionLog).where(eq(actionLog.id, id)).get()?.finishedAt).toBeTruthy();
  });
  return db.select().from(actionLog).where(eq(actionLog.id, id)).get();
}

describe('полная очистка сервера', () => {
  it('просмотр состава ничего не меняет', async () => {
    const response = await app.inject('/api/servers/s/uninstall');
    expect(response.json().revision).toBe(revision);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1]).toBe('uninstall.scan');
    expect(sshRun).not.toHaveBeenCalled();
    expect(db.select().from(actionLog).all()).toHaveLength(0);
  });

  it('проверяет новый пароль отдельным SSH-входом, затем очищает и удаляет только сервер', async () => {
    db.insert(gclients)
      .values({ id: 'client', name: 'Client', token: 'token', slug: 'client' })
      .run();
    const row = await result();
    expect(row?.exitCode).toBe(0);
    expect(vi.mocked(sshRun).mock.calls[0]?.[1]).toBe('true');
    const run = vi.mocked(sshRun).mock.calls[1];
    expect(run?.[1]).toBe('/usr/local/bin/vps-agent -uninstall-run');
    expect(run?.[0].fingerprints).toEqual(['SHA256:known']);
    const input = JSON.parse(run?.[4] ?? '{}');
    expect(input.remote).toBe(true);
    expect(input.panelKey).toMatch(/^ssh-ed25519 /);
    expect(input.password).toBeUndefined();
    expect(JSON.stringify(row)).not.toContain(body.password);
    expect(db.select().from(servers).all()).toHaveLength(0);
    expect(db.select().from(gclients).all()).toHaveLength(1);
  });

  it('ошибка снятия связи не меняет пароль и не запускает очистку', async () => {
    vi.mocked(links.detach).mockRejectedValueOnce(new Error('выход не в сети'));
    const row = await result();
    expect(row?.exitCode).toBe(1);
    expect(request.mock.calls.some((c) => c[1] === 'uninstall.prepare')).toBe(false);
    expect(sshRun).not.toHaveBeenCalled();
    expect(db.select().from(servers).all()).toHaveLength(1);
  });

  it('при ошибке входа откатывает подготовку, не запускает удаление и сохраняет запись', async () => {
    vi.mocked(sshRun).mockRejectedValueOnce(new Error('SSH: сервер не принял пароль'));
    const row = await result();
    expect(row?.exitCode).toBe(1);
    expect(sshRun).toHaveBeenCalledOnce();
    expect(request.mock.calls.map((c) => c[1])).toEqual([
      'uninstall.validate',
      'uninstall.prepare',
      'uninstall.cancel',
    ]);
    expect(db.select().from(servers).all()).toHaveLength(1);
    expect(JSON.stringify(row)).not.toContain(body.password);
  });

  it('частичная ошибка удаления не удаляет запись сервера', async () => {
    vi.mocked(sshRun).mockResolvedValueOnce({ exitCode: 0, fingerprint: 'SHA256:known' });
    vi.mocked(sshRun).mockResolvedValueOnce({ exitCode: 1, fingerprint: 'SHA256:known' });
    expect((await result())?.exitCode).toBe(1);
    expect(db.select().from(servers).all()).toHaveLength(1);
  });

  it('отказ агента до подготовки не выполняет SSH', async () => {
    request.mockRejectedValueOnce(new Error('состав сервера изменился'));
    expect((await result())?.exitCode).toBe(1);
    expect(sshRun).not.toHaveBeenCalled();
  });

  it('не принимает неверное имя, пустой пароль и очистку сервера панели', async () => {
    for (const payload of [
      { ...body, confirmName: 'wrong' },
      { ...body, password: '' },
    ]) {
      expect(
        (await app.inject({ method: 'POST', url: '/api/servers/s/uninstall', payload })).statusCode,
      ).toBe(400);
    }
    db.update(servers).set({ host: '203.0.113.1' }).where(eq(servers.id, 's')).run();
    expect(
      (await app.inject({ method: 'POST', url: '/api/servers/s/uninstall', payload: body }))
        .statusCode,
    ).toBe(409);
    expect(request).not.toHaveBeenCalled();
  });

  it('подготовка панели отвязывает соседний агент, сохраняет запись и выдаёт план без VPN-сервисов', async () => {
    db.update(servers).set({ host: '203.0.113.1' }).where(eq(servers.id, 's')).run();
    db.insert(servers)
      .values({ id: 'peer', name: 'Соседний', host: '203.0.113.30', agentTokenHash: 'hash' })
      .run();
    const original = request.getMockImplementation();
    request.mockImplementation(async (id, method, ...args) => {
      if (method === 'uninstall.scan')
        return {
          revision,
          panelHost: false,
          items: [
            { id: 'agent', owned: true },
            { id: 'portsync', owned: true },
            { id: 'naive', owned: true },
            { id: 'xui', owned: false },
          ],
        };
      return original?.(id, method, ...args);
    });
    const plan = (await app.inject('/api/servers/s/uninstall')).json();
    expect(plan.detachServers[0].ids).toEqual(['agent', 'portsync']);
    const response = await app.inject({
      method: 'POST',
      url: '/api/servers/s/uninstall/connections',
      payload: {
        confirmName: 'test',
        connectionsRevision: revision,
        servers: [{ id: 'peer', revision, ids: ['agent', 'portsync'], password: body.password }],
      },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(db.select().from(actionLog).get()?.finishedAt).toBeTruthy());
    expect(db.select().from(actionLog).get()?.exitCode).toBe(0);
    expect(db.select().from(servers).all()).toHaveLength(2);
    expect(
      db.select().from(servers).where(eq(servers.id, 'peer')).get()?.agentTokenHash,
    ).toBeNull();
    expect(getSetting(db, 'uninstall_detached:peer')).toBe('203.0.113.30:22');
    expect(getSetting(db, 'uninstall_panel_server_id')).toBe('s');
    const input = JSON.parse(vi.mocked(sshRun).mock.calls[1]?.[4] ?? '{}');
    expect(input.detachOnly).toBe(true);
    expect(input.ids).toEqual(['agent', 'portsync']);
    expect(JSON.stringify(db.select().from(actionLog).all())).not.toContain(body.password);
  });

  it('неудачная отвязка не разрешает удалять панель', async () => {
    db.update(servers).set({ host: '203.0.113.1' }).where(eq(servers.id, 's')).run();
    db.insert(servers)
      .values({ id: 'peer', name: 'Соседний', host: '203.0.113.30', agentTokenHash: 'hash' })
      .run();
    vi.mocked(sshRun).mockRejectedValueOnce(new Error('пароль не принят'));
    const response = await app.inject({
      method: 'POST',
      url: '/api/servers/s/uninstall/connections',
      payload: {
        confirmName: 'test',
        connectionsRevision: revision,
        servers: [{ id: 'peer', revision, ids: ['agent'], password: body.password }],
      },
    });
    expect(response.statusCode).toBe(200);
    await vi.waitFor(() => expect(db.select().from(actionLog).get()?.finishedAt).toBeTruthy());
    expect(db.select().from(actionLog).get()?.exitCode).toBe(1);
    expect(getSetting(db, 'uninstall_detached:peer')).toBeUndefined();
    expect(getSetting(db, 'uninstall_panel_server_id')).toBeUndefined();
    expect(db.select().from(servers).where(eq(servers.id, 'peer')).get()?.agentTokenHash).toBe(
      'hash',
    );
  });

  it('занятый сервер не начинает второе действие', async () => {
    const action = actionJournal(db, hub, registry).open('s', 'system.upgrade');
    const response = await app.inject({
      method: 'POST',
      url: '/api/servers/s/uninstall',
      payload: body,
    });
    expect(response.statusCode).toBe(409);
    expect(request).not.toHaveBeenCalled();
    await action.finish(0);
  });
});
