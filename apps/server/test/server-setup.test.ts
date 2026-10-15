import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { CATALOG } from '../src/commands/index.js';
import type { Env } from '../src/config.js';
import { type Db, createDb } from '../src/db/index.js';
import { access, backups, servers } from '../src/db/schema.js';
import { upsertAccess } from '../src/lib/access.js';
import { actionJournal } from '../src/lib/action-journal.js';
import { BackupRestorer } from '../src/lib/backup-restore.js';
import { catalogRunner } from '../src/lib/catalog-runner.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { serverSetup } from '../src/lib/server-setup.js';
import { savedXuiToken } from '../src/lib/xui-token.js';

/** Вид сервиса в отчёте агента после команды установки. */
const KIND: Record<string, string> = {
  xui: 'xui',
  mtproxyl: 'mtproxyl',
  awg: 'amnezia',
  wdtt: 'wdtt',
  openflux: 'openflux',
  naive: 'naive',
};

let dir: string;
let db: Db;
let calls: string[];
let installed: string[];
let failCommand: string | null;
let inbounds: Record<string, unknown>[];
let kicks: number;

const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });
const registry = {
  isOnline: () => true,
  isUpdating: () => false,
  latestMetrics: () => undefined,
  // снимок агента: сервисы, которые "поставили" команды
  refreshInventory: async (id: string) => {
    db.update(servers)
      .set({
        statusCache: {
          inventory: {
            services: installed.map((k) => ({ kind: k, title: k, ports: [] })),
            containers: [],
            firewall: { listeners: [] },
            audit: { rebootRequired: false, jails: [], findings: [] },
          },
        },
      } as never)
      .where(eq(servers.id, id))
      .run();
  },
  request: async (_id: string, method: string, p: Record<string, unknown>) => {
    if (method === 'command.run') {
      const c = CATALOG.find((x) => x.script === p.script);
      // проверки перед запуском: script - preflight команды
      if (!c) return { exitCode: 0, tail: 'OK|порт свободен' };
      calls.push(
        `cmd:${c.id}${(p.env as Record<string, string>).AWG_INSTANCE === 'extra' ? ':extra' : ''}`,
      );
      if (c.id === failCommand) return { exitCode: 1, killed: false };
      const k = KIND[c.id];
      if (k && !installed.includes(k)) installed.push(k);
      return { exitCode: 0, killed: false };
    }
    calls.push(method);
    // раскладка копии: в 3X-UI появляются inbound-ы старого сервера
    if (method === 'backup.restore') {
      inbounds.push({ id: 50, remark: 'old', port: 28512, protocol: 'vless' });
      return {};
    }
    if (method === 'awg.status') return { instances: [], docker: true };
    if (method === 'xui.token') return { token: 'tok' };
    if (method === 'xui.api') {
      const q = p as { method: string; path: string; body: Record<string, unknown> };
      if (q.path === 'inbounds/list') return ok(inbounds);
      if (q.path === 'server/status') return ok({ xray: { state: 'running' } });
      if (q.path === 'server/scanRealityTargets')
        return ok([
          {
            target: 'www.amd.com:443',
            host: 'www.amd.com',
            feasible: true,
            latencyMs: 5,
            serverNames: ['www.amd.com', 'amd.com'],
          },
        ]);
      if (q.path === 'inbounds/add') {
        inbounds.push({ ...q.body, id: inbounds.length + 1, protocol: 'vless' });
        return ok({ id: inbounds.length });
      }
      return { status: 404 };
    }
    return {};
  },
} as unknown as AgentRegistry;

const box = new SecretBox('s'.repeat(40));
const hub = { broadcast: () => {} };

function make() {
  const env = {
    DATA_DIR: dir,
    AGENT_DIR: dir,
    PANEL_PUBLIC_URL: 'https://panel.example.com',
  } as unknown as Env;
  const journal = actionJournal(db, hub as never, registry);
  return serverSetup({
    db,
    env,
    registry,
    box,
    hub: hub as never,
    journal,
    runner: catalogRunner({ db, env, registry, box, log: { warn: () => {} } }),
    restorer: new BackupRestorer(db, env, registry),
    gc: { kick: () => void kicks++ },
    reach: { check: async () => ({}) },
    timing: { rebootDownMs: 10, rebootUpMs: 10, pollMs: 1, xrayChecks: [1] },
  });
}

const PASSWORDS = {
  xui: { XUI_PASSWORD: 'secret-xui-1' },
  mtproxyl: { MTP_PASSWORD: 'secret-mtp-1' },
  wdtt: { WDTT_PASSWORD: 'secret-wdtt-1' },
} as Record<string, Record<string, string>>;

async function runAll(s: ReturnType<typeof make>, from?: string) {
  const plan = await s.plan('s1');
  const steps = plan.steps.map((x) => ({
    id: x.id,
    enabled: x.enabled,
    answers: { ...(x.answers ?? {}), ...(PASSWORDS[x.id] ?? {}) },
  }));
  const r = await s.run('s1', { steps, ...(from ? { from } : {}) });
  for (let i = 0; i < 200; i++) {
    const p = s.progress('s1');
    if (p?.actionId === r.actionId && p.finishedAt) return p;
    await new Promise((res) => setTimeout(res, 10));
  }
  throw new Error('настройка не закончилась');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'setup-'));
  db = createDb(dir);
  calls = [];
  installed = [];
  failCommand = null;
  inbounds = [];
  kicks = 0;
  db.insert(servers)
    .values({ id: 's1', name: 'Hoster', host: '203.0.113.10', agentTokenHash: 'x' } as never)
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('настройка сервера', () => {
  it('план: отмечено всё, кроме второго AWG; пароли пустые', async () => {
    const plan = await make().plan('s1');
    const on = plan.steps.filter((s) => s.enabled).map((s) => s.id);
    expect(on).toEqual([
      'key',
      'baseline',
      'upgrade',
      'client-host',
      'xui',
      'mtproxyl',
      'awg',
      'wdtt',
      'openflux',
      'naive',
      'inbounds',
      'gclients',
      'reboot',
      'reach',
    ]);
    expect(plan.steps.find((s) => s.id === 'awg-extra')?.enabled).toBe(false);
    expect(plan.steps.find((s) => s.id === 'xui')?.answers?.XUI_PASSWORD).toBe('');
    expect(plan.steps.find((s) => s.id === 'naive')?.answers?.NAIVE_DOMAIN).toBe(
      'hoster.panel.example.com',
    );
  });

  it('уже стоящий сервис не отмечен', async () => {
    installed = ['xui'];
    await registry.refreshInventory('s1');
    const plan = await make().plan('s1');
    const x = plan.steps.find((s) => s.id === 'xui');
    expect(x?.enabled).toBe(false);
    expect(x?.note).toBe('уже установлен');
  });

  it('без пароля запуск не начинается', async () => {
    const s = make();
    const plan = await s.plan('s1');
    await expect(
      s.run('s1', {
        steps: plan.steps.map((x) => ({ id: x.id, enabled: x.enabled, answers: x.answers ?? {} })),
      }),
    ).rejects.toThrow(/обязательное поле/);
  });

  it('всё по порядку: сервисы, токен 3X-UI, inbound-ы, синхронизация после окончания', async () => {
    const s = make();
    const p = await runAll(s);
    expect(p.steps.find((x) => x.state === 'failed')).toBeUndefined();
    expect(calls.filter((c) => c.startsWith('cmd:'))).toEqual([
      'cmd:xui',
      'cmd:mtproxyl',
      'cmd:awg',
      'cmd:wdtt',
      'cmd:openflux',
      'cmd:naive',
    ]);
    expect(calls.indexOf('ssh.keys.add')).toBeLessThan(calls.indexOf('baseline.apply'));
    expect(calls.indexOf('system.upgrade')).toBeLessThan(calls.indexOf('cmd:xui'));
    expect(savedXuiToken(db, box, 's1')).toBe('tok');
    expect(inbounds.map((i) => [i.remark, i.port])).toEqual([
      ['VLESS', expect.any(Number)],
      ['XHTTP', 8443],
    ]);
    // перезагрузка не нужна, адрес для клиентов не задан
    expect(p.steps.find((x) => x.id === 'reboot')?.state).toBe('skipped');
    expect(p.steps.find((x) => x.id === 'client-host')?.state).toBe('skipped');
    expect(kicks).toBe(1);
    expect(db.select().from(servers).get()?.gclients).toBe(true);
  });

  it('сбой - стоп; продолжение не повторяет сделанное', async () => {
    failCommand = 'mtproxyl';
    const s = make();
    const p = await runAll(s);
    expect(p.steps.find((x) => x.id === 'mtproxyl')?.state).toBe('failed');
    expect(p.steps.find((x) => x.id === 'awg')?.state).toBe('pending');
    expect(kicks).toBe(0);
    failCommand = null;
    calls = [];
    const again = await runAll(s, 'mtproxyl');
    expect(calls.filter((c) => c.startsWith('cmd:'))[0]).toBe('cmd:mtproxyl');
    expect(calls).not.toContain('ssh.keys.add');
    expect(again.steps.find((x) => x.id === 'xui')?.state).toBe('done');
    expect(again.steps.every((x) => x.state === 'done' || x.state === 'skipped')).toBe(true);
  });

  it('второй контейнер AWG 2.0 - после основного, дополнительным экземпляром', async () => {
    const s = make();
    const plan = await s.plan('s1');
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.id === 'awg' || x.id === 'awg-extra',
      answers: { ...(x.answers ?? {}) },
    }));
    const r = await s.run('s1', { steps });
    for (let i = 0; i < 200 && !s.progress('s1')?.finishedAt; i++)
      await new Promise((res) => setTimeout(res, 10));
    expect(s.progress('s1')?.actionId).toBe(r.actionId);
    expect(calls.filter((c) => c.startsWith('cmd:'))).toEqual(['cmd:awg', 'cmd:awg:extra']);
  });

  it('пересечение портов - ошибка до запуска', async () => {
    const s = make();
    const plan = await s.plan('s1');
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.enabled,
      answers: {
        ...(x.answers ?? {}),
        ...(PASSWORDS[x.id] ?? {}),
        ...(x.id === 'naive' ? { NAIVE_PORT: '8443' } : {}),
      },
    }));
    await expect(s.run('s1', { steps })).rejects.toThrow(/порт 8443/);
  });

  it('восстановление из копии: сервисы как на старом сервере, AWG из копии, данные, доступы', async () => {
    db.insert(servers)
      .values({ id: 's0', name: 'Old', host: '198.51.100.7', agentTokenHash: 'x' } as never)
      .run();
    await upsertAccess(db, box, 's0', {
      kind: 'xui',
      title: '3X-UI',
      fields: [{ label: 'Пароль', value: 'old-pass', secret: true }],
    });
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'b1.tar.gz'), 'x');
    db.insert(backups)
      .values({
        id: 'b1',
        serverId: 's0',
        serverName: 'Old',
        sha256: 'a'.repeat(64),
        manifest: {
          components: [
            { id: 'xui' },
            { id: 'wdtt' },
            { id: 'amnezia', containers: ['amnezia-awg2', 'amnezia-awg2-51820'] },
          ],
          setup: {
            services: ['xui', 'wdtt', 'amnezia', 'naive'],
            answers: { xui: { XUI_PANEL_PORT: '20530' } },
            awg: [
              { container: 'amnezia-awg2', version: '3.1', port: 55424, subnet: '10.8.3.0' },
              { container: 'amnezia-awg2-51820', version: '2.0', port: 51820, subnet: '10.8.4.0' },
            ],
            clientHost: null,
          },
        },
      } as never)
      .run();
    const s = make();
    const plan = await s.plan('s1', 'b1');
    const on = plan.steps.filter((x) => x.enabled).map((x) => x.id);
    expect(on).toEqual([
      'key',
      'baseline',
      'upgrade',
      'client-host',
      'xui',
      'awg',
      'wdtt',
      'naive',
      'awg-extra:51820',
      'restore',
      'inbounds',
      'gclients',
      'reboot',
      'reach',
    ]);
    const xui = plan.steps.find((x) => x.id === 'xui');
    expect(xui?.fromBackup).toBe(true);
    expect(xui?.answers?.XUI_PANEL_PORT).toBe('20530');
    expect(plan.steps.find((x) => x.id === 'awg')?.answers).toMatchObject({
      AWG_VERSION: '3.1',
      AWG_SERVER_PORT: '55424',
      AWG_SUBNET_IP: '10.8.3.0',
    });
    expect(plan.steps.find((x) => x.id === 'awg-extra:51820')?.locked).toBe(true);
    // пароли не вводятся, второй AWG нельзя выключить
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.id === 'awg-extra:51820' ? false : x.enabled,
      answers: x.answers ?? {},
    }));
    const r = await s.run('s1', { backupId: 'b1', steps });
    for (let i = 0; i < 200 && !s.progress('s1')?.finishedAt; i++)
      await new Promise((res) => setTimeout(res, 10));
    const p = s.progress('s1');
    expect(p?.actionId).toBe(r.actionId);
    expect(p?.backupId).toBe('b1');
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    expect(calls.filter((c) => c.startsWith('cmd:'))).toEqual([
      'cmd:xui',
      'cmd:awg',
      'cmd:wdtt',
      'cmd:naive',
      'cmd:awg:extra',
    ]);
    expect(calls.indexOf('backup.restore')).toBeGreaterThan(-1);
    // токен 3X-UI выпущен после раскладки (база заменена)
    expect(calls.lastIndexOf('xui.token')).toBeGreaterThan(calls.indexOf('backup.restore'));
    // inbound-ы пришли из копии - свои не добавляются
    expect(inbounds.map((i) => i.remark)).toEqual(['old']);
    expect(p?.steps.find((x) => x.id === 'inbounds')?.state).toBe('skipped');
    const acc = db
      .select()
      .from(access)
      .all()
      .find((a) => a.serverId === 's1' && a.kind === 'xui');
    expect(acc && box.open(acc.fields[0]?.value ?? '')).toBe('old-pass');
  });

  it('копия без состава сервисов (до 1.6) - восстановление с установкой недоступно', async () => {
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'b2.tar.gz'), 'x');
    db.insert(backups)
      .values({
        id: 'b2',
        serverId: 's1',
        serverName: 'Old',
        manifest: { components: [{ id: 'xui' }] },
      } as never)
      .run();
    await expect(make().plan('s1', 'b2')).rejects.toThrow(/до версии 1\.6/);
  });
});
