import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ConnsView, Inventory, Metrics } from '@vps/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { loadLogSettings, saveLogSettings } from '../src/lib/server-log-bind.js';
import { SESSION_GAP_MS, ServerLog, formatRows } from '../src/lib/server-log.js';

const MIN = 60_000;
const DAY = 86_400_000;
const T0 = Date.parse('2026-11-10T12:00:00Z');

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'slog-'));
  dirs.push(dir);
  let now = T0;
  const log = new ServerLog(join(dir, 'logs.db'), () => now);
  log.refs([{ id: 's1', name: 'Hoster', host: '203.0.113.5' }]);
  return {
    log,
    at: (ms: number) => {
      now = ms;
    },
    get now() {
      return now;
    },
  };
}

const names = (ids: string[]) => new Map(ids.map((id) => [id, `Клиент ${id}`]));

function view(addrs: { ip: string; user?: string; clientId?: string }[]): ConnsView {
  return {
    at: new Date().toISOString(),
    clients: null,
    conns: 0,
    addresses: addrs.length,
    truncated: false,
    ports: [],
    errors: {},
    awg: [],
    addrs: addrs.map((a) => ({
      ip: a.ip,
      kind: a.clientId ? 'client' : 'unknown',
      name: a.user ?? null,
      users: a.user
        ? [
            {
              name: a.user,
              kind: 'client' as const,
              ...(a.clientId ? { clientId: a.clientId } : {}),
            },
          ]
        : [],
      note: '',
      conns: 3,
      ports: [{ port: 443, label: '3X-UI RAW', conns: 3 }],
    })),
  };
}

const metrics = (uptimeSec: number): Metrics => ({
  cpuPercent: 10,
  memTotalMb: 1000,
  memUsedMb: 500,
  diskTotalGb: 20,
  diskUsedGb: 5,
  netRxBps: 100,
  netTxBps: 200,
  uptimeSec,
  load1: 0.5,
});

function inv(p: { bans?: string[]; services?: { kind: string; version: string }[] }): Inventory {
  return {
    host: { hostname: 'h', os: 'Ubuntu', kernel: '6.8', arch: 'amd64', agentVersion: '0.3.2' },
    services: (p.services ?? []).map((s) => ({
      kind: s.kind as Inventory['services'][number]['kind'],
      title: s.kind,
      version: s.version,
      ports: [],
    })),
    containers: [],
    firewall: { listeners: [] } as unknown as Inventory['firewall'],
    audit: {
      sshPort: 22,
      sshPasswordAuth: false,
      sshPermitRootLogin: 'prohibit-password',
      fail2banRunning: true,
      fail2banJails: ['sshd'],
      jails: [{ name: 'sshd', banned: 0, totalBanned: 0, failed: 0, bannedIps: p.bans ?? [] }],
    } as unknown as Inventory['audit'],
    certs: [],
    unchecked: [],
    collectedAt: '',
  };
}

const count = (log: ServerLog, sql: string) => (log.sqlite.prepare(sql).get() as { n: number }).n;

describe('журнал серверов', () => {
  it('сеанс подключения продлевается, пока адрес виден, и начинается заново после перерыва', () => {
    const t = setup();
    const v = view([{ ip: '198.51.100.7', user: 'anna', clientId: 'c1' }]);
    t.log.conns('s1', v, names);
    t.at(T0 + 2 * MIN);
    t.log.conns('s1', v, names);
    // чаще раза в минуту снимок не пишется
    t.at(T0 + 2 * MIN + 10_000);
    t.log.conns('s1', v, names);
    const row = t.log.sqlite.prepare('select * from conn').get() as Record<string, unknown>;
    expect(row).toMatchObject({ samples: 2, client_id: 'c1', client_name: 'Клиент c1' });
    expect(row.last_at).toBe(T0 + 2 * MIN);

    t.at(T0 + 2 * MIN + SESSION_GAP_MS + MIN);
    t.log.conns('s1', v, names);
    expect(count(t.log, 'select count(*) n from conn')).toBe(2);
  });

  it('сеансы переживают перезапуск панели', () => {
    const t = setup();
    const v = view([{ ip: '198.51.100.7' }]);
    t.log.conns('s1', v, names);
    t.log.close();
    const again = new ServerLog(t.log.file, () => T0 + 3 * MIN);
    again.conns('s1', v, names);
    expect(count(again, 'select count(*) n from conn')).toBe(1);
    again.close();
  });

  it('сдвиг времени загрузки - событие о перезагрузке', () => {
    const t = setup();
    t.log.metric('s1', metrics(3600));
    t.at(T0 + 5 * MIN);
    t.log.metric('s1', metrics(3600 + 300));
    expect(count(t.log, "select count(*) n from event where type = 'reboot'")).toBe(0);
    t.at(T0 + 20 * MIN);
    t.log.metric('s1', metrics(120));
    const ev = t.log.sqlite.prepare("select * from event where type = 'reboot'").get() as {
      at: number;
      level: string;
    };
    expect(ev.at).toBe(T0 + 18 * MIN);
    expect(ev.level).toBe('warn');
    expect(count(t.log, 'select count(*) n from metric')).toBe(3);
  });

  it('разница снимков агента: баны fail2ban и версии сервисов', () => {
    const t = setup();
    t.log.inventory(
      's1',
      inv({ bans: ['203.0.113.9'], services: [{ kind: 'xui', version: '2.5' }] }),
    );
    // первый снимок - точка отсчёта, без событий
    expect(count(t.log, 'select count(*) n from event')).toBe(0);
    t.log.inventory(
      's1',
      inv({ bans: ['198.51.100.1'], services: [{ kind: 'xui', version: '2.6' }] }),
    );
    const rows = t.log.sqlite.prepare('select type, ip from event order by id').all();
    expect(rows).toEqual([
      { type: 'service.version', ip: null },
      { type: 'fail2ban.ban', ip: '198.51.100.1' },
      { type: 'fail2ban.unban', ip: '203.0.113.9' },
    ]);
  });

  it('сроки хранения по разделам и свёртка нагрузки по часам', () => {
    const t = setup();
    const ev = (category: 'agent' | 'reach', days: number) =>
      t.log.event({
        serverId: 's1',
        category,
        level: 'info',
        type: 'x',
        text: 'x',
        at: T0 - days * DAY,
      });
    ev('agent', 10);
    ev('reach', 10);
    t.log.configure({ ...t.log.settings, days: { ...t.log.settings.days, reach: 5 } });
    for (let i = 0; i < 3; i++) {
      t.at(T0 - 8 * DAY + i * MIN);
      t.log.metric('s1', metrics(1000 + i * 60));
    }
    t.at(T0);
    t.log.prune();
    expect(t.log.sqlite.prepare('select category from event').all()).toEqual([
      { category: 'agent' },
    ]);
    expect(t.log.sqlite.prepare('select span, cpu from metric').all()).toEqual([
      { span: 3600, cpu: 10 },
    ]);
  });

  it('удаление по фильтру и выключенный журнал', () => {
    const t = setup();
    t.log.conns('s1', view([{ ip: '198.51.100.7' }, { ip: '198.51.100.8' }]), names);
    t.log.event({ serverId: 's1', category: 'agent', level: 'info', type: 'online', text: 'x' });
    t.log.event({ serverId: 's2', category: 'agent', level: 'info', type: 'online', text: 'x' });
    expect(t.log.delete({ ip: '198.51.100.7' })).toBe(1);
    expect(t.log.delete({ servers: ['s2'], categories: ['agent'] })).toBe(1);
    expect(t.log.delete({})).toBe(2);
    t.log.configure({ ...t.log.settings, enabled: false });
    t.log.event({ serverId: 's1', category: 'agent', level: 'info', type: 'online', text: 'x' });
    expect(count(t.log, 'select count(*) n from event')).toBe(0);
  });

  it('выгрузка: имя сервера, фильтр по клиенту, CSV с экранированием', () => {
    const t = setup();
    t.log.conns('s1', view([{ ip: '198.51.100.7', user: 'anna', clientId: 'c1' }]), names);
    t.log.event({
      serverId: 's1',
      category: 'action',
      level: 'error',
      type: 'command:xui',
      text: 'Установка, "3X-UI": ошибка',
      clientId: 'c2',
    });
    const rows = [...t.log.rows({ clientId: 'c1' })];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'conn', server: 'Hoster', client: 'Клиент c1' });
    const csv = [...formatRows(t.log.rows({ categories: ['action'] }), 'csv')].join('');
    expect(csv).toContain('"Установка, ""3X-UI"": ошибка"');
    const jsonl = [...formatRows(t.log.rows({}), 'jsonl')];
    expect(jsonl).toHaveLength(2);
  });

  it('настройки: значения вне пределов - по умолчанию', () => {
    const db = createDb(':memory:');
    saveLogSettings(db, {
      enabled: false,
      days: { agent: 0, reach: 30, conn: 99999, action: 10, server: 10, metric: 10 },
      maxMb: 1,
    });
    const s = loadLogSettings(db);
    expect(s.enabled).toBe(false);
    expect(s.days).toMatchObject({ agent: 365, reach: 30, conn: 60 });
    expect(s.maxMb).toBe(1024);
  });
});

describe('маршруты /api/logs', () => {
  async function app() {
    const Fastify = (await import('fastify')).default;
    const cookie = (await import('@fastify/cookie')).default;
    const { logRoutes } = await import('../src/routes/logs.js');
    const { StepUp } = await import('../src/lib/step-up.js');
    const { sha256 } = await import('../src/lib/auth.js');
    const t = setup();
    const db = createDb(':memory:');
    const stepUp = new StepUp();
    const a = Fastify();
    await a.register(cookie);
    // как общий обработчик приложения: ошибка схемы - 400
    const { ZodError } = await import('zod');
    a.setErrorHandler((e, _req, reply) => reply.code(e instanceof ZodError ? 400 : 500).send());
    await a.register(logRoutes, { db, slog: t.log, stepUp, secure: false });
    const cookies = { vps_session: 'tok', vps_stepup: stepUp.issue(sha256('tok')) };
    return { a, t, db, cookies };
  }

  it('выгрузка и удаление - только после подтверждения; выгрузка - gzip с записями', async () => {
    const { gunzipSync } = await import('node:zlib');
    const { a, t, cookies } = await app();
    t.log.event({
      serverId: 's1',
      category: 'agent',
      level: 'warn',
      type: 'offline',
      text: 'обрыв',
    });
    expect((await a.inject({ url: '/api/logs/export' })).statusCode).toBe(403);
    const r = await a.inject({ url: '/api/logs/export?categories=agent', cookies });
    expect(r.statusCode).toBe(200);
    const lines = gunzipSync(r.rawPayload).toString().trim().split('\n');
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ server: 'Hoster', text: 'обрыв' });
    expect(
      (await a.inject({ method: 'POST', url: '/api/logs/delete', payload: {} })).statusCode,
    ).toBe(403);
    const d = await a.inject({ method: 'POST', url: '/api/logs/delete', payload: {}, cookies });
    // удалено событие и запись о выгрузке; само удаление записано после
    expect(d.json().deleted).toBe(2);
    expect(t.log.sqlite.prepare('select type from event').all()).toEqual([{ type: 'delete' }]);
    await a.close();
  });

  it('настройки сохраняются и проверяются', async () => {
    const { a, db } = await app();
    const bad = await a.inject({
      method: 'PUT',
      url: '/api/logs/settings',
      payload: { enabled: true, days: {}, maxMb: 1 },
    });
    expect(bad.statusCode).toBe(400);
    const body = {
      enabled: false,
      days: { agent: 30, reach: 30, conn: 7, action: 30, server: 30, metric: 14 },
      maxMb: 200,
    };
    const ok = await a.inject({ method: 'PUT', url: '/api/logs/settings', payload: body });
    expect(ok.json().settings).toEqual(body);
    expect(loadLogSettings(db)).toEqual(body);
    await a.close();
  });
});
