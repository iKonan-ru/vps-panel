import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { CATALOG } from '../src/commands/index.js';
import type { Env } from '../src/config.js';
import { type Db, createDb } from '../src/db/index.js';
import {
  access,
  awgClients,
  backups,
  gclientBindings,
  gclients,
  servers,
} from '../src/db/schema.js';
import { upsertAccess } from '../src/lib/access.js';
import { actionJournal } from '../src/lib/action-journal.js';
import { BackupRestorer } from '../src/lib/backup-restore.js';
import { catalogRunner } from '../src/lib/catalog-runner.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { serverSetup } from '../src/lib/server-setup.js';
import { keyFingerprint, loadPanelKey } from '../src/lib/ssh.js';
import { savedXuiToken } from '../src/lib/xui-token.js';

/** Вид сервиса в отчёте агента после команды установки. */
vi.mock('../src/lib/client-host.js', async (orig) => ({
  ...(await orig<typeof import('../src/lib/client-host.js')>()),
  checkClientHost: async () => ({ ok: true, addresses: ['203.0.113.10'] }),
}));

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
let awgHere: { container: string; port: number; address: string }[];
let awgEnv: Record<string, string>[];
let restoreParams: Record<string, unknown>[];
/** Ответы опроса перед планом; null - агент такого не умеет. */
let rootKeys: string[] | null;
let baselineNeeded: string[] | null;
let baselineNothing: boolean;
/** Восстановитель этого теста: фейковый агент "загружает" в него архив свежей копии. */
let restorerRef: BackupRestorer;
/** На каком сервере выполнялась команда каталога (для снятия сервисов со старого). */
let cmdServers: string[];

const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });
const registry = {
  isOnline: (_id: string) => true,
  isUpdating: () => false,
  get: () => undefined,
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
  request: async (id: string, method: string, p: Record<string, unknown>) => {
    if (method === 'command.run') {
      const c = CATALOG.find((x) => x.script === p.script);
      // проверки перед запуском: script - preflight команды; снятие агента - свой скрипт
      if (!c) {
        if (String(p.script).includes('vps-agent-remove')) calls.push(`agent-remove:${id}`);
        const env = (p.env ?? {}) as Record<string, string>;
        if ('MT_HOST' in env) calls.push(`mt-host:${env.MT_HOST}`);
        return { exitCode: 0, tail: 'OK|порт свободен' };
      }
      const e = p.env as Record<string, string>;
      if (c.id === 'awg') awgEnv.push(e);
      calls.push(`cmd:${c.id}${e.AWG_INSTANCE === 'extra' ? ':extra' : ''}`);
      cmdServers.push(`${id}:${c.id}`);
      if (c.id === failCommand) return { exitCode: 1, killed: false };
      // удаление: сервиса больше нет в отчёте
      const gone = KIND[c.id.replace(/-uninstall$/, '')];
      if (c.id.endsWith('-uninstall') && gone) {
        installed = installed.filter((x) => x !== gone);
        return { exitCode: 0, killed: false };
      }
      const k = KIND[c.id];
      if (k && !installed.includes(k)) installed.push(k);
      return { exitCode: 0, killed: false };
    }
    calls.push(method);
    // раскладка копии: в 3X-UI появляются inbound-ы старого сервера
    if (method === 'backup.restore') {
      restoreParams.push(p);
      inbounds.push({ id: 50, remark: 'old', port: 28512, protocol: 'vless' });
      return {};
    }
    if (method === 'ssh.keys.list' && rootKeys)
      return { keys: rootKeys.map((fingerprint) => ({ fingerprint })), passwordLogin: false };
    if (method === 'baseline.plan' && baselineNeeded)
      return { steps: baselineNeeded.map((title) => ({ id: title, title, needed: true })) };
    if (method === 'baseline.apply' && baselineNothing) throw new Error('исправлять нечего');
    // свежая копия: агент "загружает" архив по токену и отвечает манифестом
    if (method === 'backup.create') {
      const u = restorerRef.upload(String(p.token));
      if (!u) throw new Error('нет загрузки');
      mkdirSync(join(dir, 'backups'), { recursive: true });
      writeFileSync(join(dir, 'backups', `${u.backupId}.tar.gz`), 'fresh');
      u.sha256 = createHash('sha256').update('fresh').digest('hex');
      return { sha256: u.sha256, archiveSize: 5, hostname: 'old', components: [{ id: 'xui' }] };
    }
    if (method === 'awg.status') return { instances: awgHere, docker: true };
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
  restorerRef = new BackupRestorer(db, env, registry);
  return serverSetup({
    db,
    env,
    registry,
    box,
    hub: hub as never,
    journal,
    runner: catalogRunner({ db, env, registry, box, log: { warn: () => {} } }),
    restorer: restorerRef,
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
  awgHere = [];
  awgEnv = [];
  restoreParams = [];
  rootKeys = null;
  baselineNeeded = null;
  baselineNothing = false;
  cmdServers = [];
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

  it('опрос сервера: сделанное заранее выключено и объяснено', async () => {
    installed = ['xui'];
    await registry.refreshInventory('s1');
    const cache = db.select().from(servers).get()?.statusCache as {
      inventory: { audit: Record<string, unknown> };
    };
    cache.inventory.audit.pendingUpdates = 0;
    db.update(servers)
      .set({ statusCache: cache } as never)
      .run();
    inbounds = [{ id: 1, remark: 'mine', port: 443, protocol: 'vless' }];
    rootKeys = [keyFingerprint(loadPanelKey(dir).publicKey)];
    baselineNeeded = [];
    const plan = await make().plan('s1');
    const step = (id: string) => plan.steps.find((x) => x.id === id);
    expect(step('key')).toMatchObject({ enabled: false, note: 'ключ панели уже есть' });
    expect(step('baseline')).toMatchObject({ enabled: false, note: 'проблем не найдено' });
    expect(step('upgrade')).toMatchObject({ enabled: false, note: 'обновлений нет' });
    expect(step('inbounds')).toMatchObject({ enabled: false, note: 'свои inbound VLESS уже есть' });
  });

  it('опрос сервера: есть что исправить - шаг включён и сказано что', async () => {
    rootKeys = ['SHA256:other'];
    baselineNeeded = ['fail2ban', 'ufw'];
    const plan = await make().plan('s1');
    expect(plan.steps.find((x) => x.id === 'key')?.enabled).toBe(true);
    expect(plan.steps.find((x) => x.id === 'baseline')).toMatchObject({
      enabled: true,
      note: 'исправит: fail2ban; ufw',
    });
  });

  it('исправлять нечего - не ошибка', async () => {
    baselineNothing = true;
    const p = await runAll(make());
    expect(p.steps.find((x) => x.id === 'baseline')).toMatchObject({
      state: 'done',
      note: 'проблем не найдено',
    });
    expect(p.steps.find((x) => x.state === 'failed')).toBeUndefined();
  });

  it('адрес для клиентов: стоящий MTProxyL получает его в ссылки, клиенты - в очередь', async () => {
    installed = ['mtproxyl'];
    await registry.refreshInventory('s1');
    db.insert(gclients)
      .values({
        id: 'c1',
        name: 'Ann',
        slug: 'ann',
        token: 't'.repeat(32),
        xuiSubId: 'sub',
      } as never)
      .run();
    db.insert(gclientBindings)
      .values({
        id: 'b1',
        clientId: 'c1',
        serverId: 's1',
        service: 'mtproxyl',
        ref: 'ann',
        state: 'ok',
        updatedAt: '2026-01-01T00:00:00.000Z',
      } as never)
      .run();
    const s = make();
    const plan = await s.plan('s1');
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.id === 'client-host',
      answers: x.id === 'client-host' ? { NAME: 'vpn.example.com' } : (x.answers ?? {}),
    }));
    const r = await s.run('s1', { steps });
    for (let i = 0; i < 200 && !s.progress('s1')?.finishedAt; i++)
      await new Promise((res) => setTimeout(res, 10));
    expect(s.progress('s1')?.actionId).toBe(r.actionId);
    expect(calls).toContain('mt-host:vpn.example.com');
    expect(db.select().from(servers).get()?.clientHost).toBe('vpn.example.com');
    expect(db.select().from(gclientBindings).get()?.state).toBe('pending');
    expect(kicks).toBe(1);
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

  it('перенос из копии старого сервера: сервисы как на нём, AWG из копии, данные, доступы', async () => {
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
    // копия чужого сервера без переноса не разворачивается
    await expect(s.plan('s1', 'b1')).rejects.toThrow(/копия другого сервера/);
    const plan = await s.plan('s1', { migrateFrom: 's0', backupId: 'b1' });
    const on = plan.steps.filter((x) => x.enabled).map((x) => x.id);
    expect(on).toEqual([
      'key',
      'baseline',
      'upgrade',
      'client-host',
      'xui',
      'awg',
      'awg-extra:51820',
      'wdtt',
      'naive',
      'restore',
      'inbounds',
      'migrate',
      'gclients',
      'reboot',
      'retire',
      'reach',
    ]);
    expect(plan.migrate).toMatchObject({ id: 's0', name: 'Old' });
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
      answers: { ...(x.answers ?? {}), ...(x.id === 'retire' ? { MODE: 'keep' } : {}) },
    }));
    const r = await s.run('s1', { migrateFrom: 's0', backupId: 'b1', steps });
    for (let i = 0; i < 200 && !s.progress('s1')?.finishedAt; i++)
      await new Promise((res) => setTimeout(res, 10));
    const p = s.progress('s1');
    expect(p?.actionId).toBe(r.actionId);
    expect(p?.backupId).toBe('b1');
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    expect(calls.filter((c) => c.startsWith('cmd:'))).toEqual([
      'cmd:xui',
      'cmd:awg',
      'cmd:awg:extra',
      'cmd:wdtt',
      'cmd:naive',
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

  /** Копия с 3X-UI и AWG (основной на 10.8.1.0) для восстановления поверх рабочего сервера. */
  function copyB3() {
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'b3.tar.gz'), 'x');
    db.insert(backups)
      .values({
        id: 'b3',
        serverId: 's1',
        serverName: 'Old',
        sha256: 'a'.repeat(64),
        manifest: {
          components: [{ id: 'xui' }, { id: 'amnezia', containers: ['amnezia-awg2'] }],
          setup: {
            services: ['xui', 'amnezia'],
            answers: {},
            awg: [{ container: 'amnezia-awg2', version: '3.1', port: 55424, subnet: '10.8.1.0' }],
            clientHost: null,
          },
        },
      } as never)
      .run();
  }

  async function finished(s: ReturnType<typeof make>, actionId: string) {
    for (let i = 0; i < 200 && s.progress('s1')?.actionId !== actionId; i++)
      await new Promise((res) => setTimeout(res, 5));
    for (let i = 0; i < 200 && !s.progress('s1')?.finishedAt; i++)
      await new Promise((res) => setTimeout(res, 10));
    return s.progress('s1');
  }

  it('копия поверх рабочего сервера: стоящее - оставить, мешающий контейнер - удалить по выбору', async () => {
    copyB3();
    installed = ['xui', 'amnezia'];
    await registry.refreshInventory('s1');
    // основной контейнер есть, но на другой подсети; дополнительный занял подсеть копии
    awgHere = [
      { container: 'amnezia-awg2', port: 55424, address: '10.8.7.1/24' },
      { container: 'amnezia-awg2-40748', port: 40748, address: '10.8.1.1/24' },
    ];
    const s = make();
    const plan = await s.plan('s1', 'b3');
    const xui = plan.steps.find((x) => x.id === 'xui');
    expect(xui?.modes).toEqual(['keep', 'reinstall', 'skip']);
    expect(xui?.answers?.MODE).toBe('keep');
    const awg = plan.steps.find((x) => x.id === 'awg');
    expect(awg?.modes).toEqual(['keep', 'reinstall', 'skip']);
    const rm = plan.steps.find((x) => x.id === 'awg-remove:amnezia-awg2-40748');
    expect(rm?.enabled).toBe(false);
    expect(rm?.note).toMatch(/подсеть 10\.8\.1\.0/);
    // удаление не отмечено - запуск не начинается
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.enabled,
      answers: x.answers ?? {},
    }));
    await expect(s.run('s1', { backupId: 'b3', steps })).rejects.toThrow(/отметить удаление/);
    // отмечено: контейнер удаляется, основной пересоздаётся с подсетью копии, 3X-UI не ставится
    const r = await s.run('s1', {
      backupId: 'b3',
      steps: steps.map((x) => (x.id === rm?.id ? { ...x, enabled: true } : x)),
    });
    const p = await finished(s, r.actionId);
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    const cmds = calls.filter((c) => c.startsWith('cmd:'));
    expect(cmds).toEqual(['cmd:awg-uninstall', 'cmd:awg']);
    expect(awgEnv[0]).toMatchObject({
      AWG_REPLACE: 'replace',
      AWG_SUBNET_IP: '10.8.1.0',
      AWG_INSTANCE: 'main',
    });
    expect(restoreParams[0]?.components).toEqual([]);
  });

  it('"не трогать" у 3X-UI - его данные из копии не раскладываются', async () => {
    copyB3();
    installed = ['xui'];
    await registry.refreshInventory('s1');
    const s = make();
    const plan = await s.plan('s1', 'b3');
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.enabled,
      answers: { ...(x.answers ?? {}), ...(x.id === 'xui' ? { MODE: 'skip' } : {}) },
    }));
    const r = await s.run('s1', { backupId: 'b3', steps });
    const p = await finished(s, r.actionId);
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    expect(p?.steps.some((x) => x.id === 'xui')).toBe(false);
    expect(restoreParams[0]?.components).toEqual(['amnezia']);
  });

  it('переустановка: сначала удаление, затем установка', async () => {
    copyB3();
    installed = ['xui'];
    await registry.refreshInventory('s1');
    const s = make();
    const plan = await s.plan('s1', 'b3');
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.enabled,
      answers: { ...(x.answers ?? {}), ...(x.id === 'xui' ? { MODE: 'reinstall' } : {}) },
    }));
    const r = await s.run('s1', { backupId: 'b3', steps });
    const p = await finished(s, r.actionId);
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    expect(calls.filter((c) => c.startsWith('cmd:')).slice(0, 2)).toEqual([
      'cmd:xui-uninstall',
      'cmd:xui',
    ]);
  });
  /** Старый сервер с клиентом: привязки 3X-UI и AWG, ключ AWG, доступ клиента по списку. */
  function oldServerWithClient() {
    db.insert(servers)
      .values({
        id: 's0',
        name: 'Old',
        host: '198.51.100.7',
        agentTokenHash: 'x',
        xuiExcluded: [7],
      } as never)
      .run();
    db.insert(gclients)
      .values({
        id: 'c1',
        name: 'Оля',
        token: 'd'.repeat(32),
        slug: 'olya',
        access: [{ serverId: 's0', services: ['xui', 'awg'] }],
      } as never)
      .run();
    db.insert(gclientBindings)
      .values([
        {
          id: 'b-old-xui',
          clientId: 'c1',
          serverId: 's0',
          service: 'xui',
          ref: 'olya',
          state: 'ok',
        },
        {
          id: 'b-old-awg',
          clientId: 'c1',
          serverId: 's0',
          service: 'awg',
          ref: '3|amnezia-awg2|PUBOLD',
          state: 'ok',
        },
        // на новом сервере синхронизация уже успела завести клиенту свою запись
        {
          id: 'b-new-xui',
          clientId: 'c1',
          serverId: 's1',
          service: 'xui',
          ref: 'olya',
          state: 'ok',
        },
      ] as never)
      .run();
    db.insert(awgClients)
      .values({ serverId: 's0', container: 'amnezia-awg2', publicKey: 'PUBOLD', privateKey: 'k' })
      .run();
  }

  it('перенос со свежей копией: копия снимается, клиенты переходят, старый сервер снимается', async () => {
    oldServerWithClient();
    installed = ['xui'];
    await registry.refreshInventory('s0');
    installed = [];
    await registry.refreshInventory('s1');
    const s = make();
    const plan = await s.plan('s1', { migrateFrom: 's0' });
    expect(plan.steps.map((x) => x.id).slice(0, 3)).toEqual(['key', 'snapshot', 'baseline']);
    const retire = plan.steps.find((x) => x.id === 'retire');
    expect(retire?.modes).toEqual(['remove', 'delete', 'keep']);
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.enabled,
      answers: { ...(x.answers ?? {}), ...(PASSWORDS[x.id] ?? {}) },
    }));
    const r = await s.run('s1', { migrateFrom: 's0', steps });
    const p = await finished(s, r.actionId);
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    // копия снята и разложена именно она
    expect(p?.backupId).toBeTruthy();
    expect(calls.indexOf('backup.create')).toBeLessThan(calls.indexOf('backup.restore'));
    // привязки старого - у нового, в очереди; своя запись нового убрана
    const bs = db.select().from(gclientBindings).all();
    expect(bs.map((b) => [b.id, b.serverId, b.state]).sort()).toEqual([
      ['b-old-awg', 's1', 'pending'],
      ['b-old-xui', 's1', 'pending'],
    ]);
    expect(
      db
        .select()
        .from(awgClients)
        .all()
        .map((k) => k.serverId),
    ).toEqual(['s1']);
    expect(db.select().from(gclients).get()?.access).toEqual([
      { serverId: 's1', services: ['xui', 'awg'] },
    ]);
    expect(db.select().from(servers).where(eq(servers.id, 's1')).get()?.xuiExcluded).toEqual([7]);
    // старый: сервисы сняты на нём, агент снят, из панели удалён
    expect(cmdServers).toContain('s0:xui-uninstall');
    expect(calls).toContain('agent-remove:s0');
    expect(db.select().from(servers).where(eq(servers.id, 's0')).get()).toBeUndefined();
  });

  it('перенос: старый не в сети - только удалить из панели или оставить', async () => {
    oldServerWithClient();
    const s = make();
    const online = registry.isOnline;
    registry.isOnline = (id: string) => id !== 's0';
    try {
      // свежую копию не снять
      await expect(s.plan('s1', { migrateFrom: 's0' })).rejects.toThrow(/не в сети/);
      copyB0();
      const plan = await s.plan('s1', { migrateFrom: 's0', backupId: 'b0' });
      expect(plan.steps.find((x) => x.id === 'retire')).toMatchObject({
        modes: ['delete', 'keep'],
        answers: { MODE: 'delete' },
      });
      const steps = plan.steps.map((x) => ({
        id: x.id,
        enabled: x.enabled,
        answers: {
          ...(x.answers ?? {}),
          ...(PASSWORDS[x.id] ?? {}),
          ...(x.id === 'retire' ? { MODE: 'remove' } : {}),
        },
      }));
      const pf = await s.preflight('s1', { migrateFrom: 's0', backupId: 'b0', steps });
      expect(pf.checks.find((c) => c.step === 'retire')?.text).toMatch(/не в сети/);
      const keep = steps.map((x) => (x.id === 'retire' ? { ...x, answers: { MODE: 'keep' } } : x));
      const r = await s.run('s1', { migrateFrom: 's0', backupId: 'b0', steps: keep });
      const p = await finished(s, r.actionId);
      expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
      // оставлен в панели, но клиентов на нём больше нет
      const old = db.select().from(servers).where(eq(servers.id, 's0')).get();
      expect(old?.gclients).toBe(false);
      expect(
        db
          .select()
          .from(gclientBindings)
          .all()
          .every((b) => b.serverId === 's1'),
      ).toBe(true);
    } finally {
      registry.isOnline = online;
    }
  });

  function copyB0() {
    mkdirSync(join(dir, 'backups'), { recursive: true });
    writeFileSync(join(dir, 'backups', 'b0.tar.gz'), 'x');
    db.insert(backups)
      .values({
        id: 'b0',
        serverId: 's0',
        serverName: 'Old',
        sha256: 'a'.repeat(64),
        manifest: {
          components: [{ id: 'xui' }],
          setup: { services: ['xui'], answers: {}, awg: [], clientHost: null },
        },
      } as never)
      .run();
  }

  it('очистка при восстановлении: стоящее удаляется, привязки к записям из копии остаются', async () => {
    copyB3();
    installed = ['xui', 'mtproxyl', 'amnezia'];
    await registry.refreshInventory('s1');
    awgHere = [{ container: 'amnezia-awg2', port: 55424, address: '10.8.1.1/24' }];
    db.insert(gclients)
      .values({ id: 'c1', name: 'Оля', token: 'd'.repeat(32), slug: 'olya' } as never)
      .run();
    db.insert(gclientBindings)
      .values([
        { id: 'bx', clientId: 'c1', serverId: 's1', service: 'xui', ref: 'olya', state: 'ok' },
        { id: 'bm', clientId: 'c1', serverId: 's1', service: 'mtproxyl', ref: 'olya', state: 'ok' },
      ] as never)
      .run();
    const s = make();
    const plan = await s.plan('s1', { backupId: 'b3', wipe: true });
    expect(plan.installed).toEqual(['3X-UI', 'MTProxyL']);
    const w = plan.steps.find((x) => x.id === 'wipe');
    expect(w?.note).toMatch(/3X-UI, MTProxyL/);
    // всё ставится как на пустой: выбора "оставить" нет
    expect(plan.steps.some((x) => x.modes)).toBe(false);
    const steps = plan.steps.map((x) => ({
      id: x.id,
      enabled: x.enabled,
      answers: x.answers ?? {},
    }));
    const r = await s.run('s1', { backupId: 'b3', wipe: true, steps });
    const p = await finished(s, r.actionId);
    expect(p?.steps.find((x) => x.state === 'failed')).toBeUndefined();
    const cmds = calls.filter((c) => c.startsWith('cmd:'));
    expect(cmds.slice(0, 3)).toEqual([
      'cmd:xui-uninstall',
      'cmd:mtproxyl-uninstall',
      'cmd:awg-uninstall',
    ]);
    expect(cmds).toContain('cmd:xui');
    // 3X-UI вернулся с данными копии - привязка осталась; MTProxyL в копии нет - снята
    const ids = db
      .select()
      .from(gclientBindings)
      .all()
      .map((b) => b.id);
    expect(ids).toEqual(['bx']);
  });
});
