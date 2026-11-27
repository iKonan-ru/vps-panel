import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServiceUpdate } from '@vps/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { type Db, createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import type { Action } from '../src/lib/action-journal.js';
import type { SecretBox } from '../src/lib/secret-box.js';
import {
  BUILD_CHECK_SCRIPT,
  buildLabel,
  buildUpdateScript,
  parseBuildCheck,
} from '../src/lib/service-builds.js';
import { ServiceUpdates } from '../src/lib/service-updates.js';

const NAIVE_VERSION = 'caddy v2.11.9\nforwardproxy v0.0.0-20261022172731-e747854e7874\n';

describe('метки сборок', () => {
  it('wdtt - как есть, naive - версия Caddy и коммит forwardproxy', () => {
    expect(buildLabel('wdtt', '1.4.5+7345d56\n')).toBe('1.4.5+7345d56');
    expect(buildLabel('naive', NAIVE_VERSION)).toBe('2.11.9+e747854');
    expect(buildLabel('naive', 'мусор')).toBe('');
  });

  it('скрипт проверки: метки обеих сборок одной строкой, нет файла - пусто', () => {
    expect(BUILD_CHECK_SCRIPT).toContain('/etc/wdtt/vps-panel-build');
    expect(
      parseBuildCheck(
        `B:wdtt:1.4.5+7345d56|\nB:naive:${NAIVE_VERSION.replace(/\n/g, '|')}\nлишнее\n`,
      ),
    ).toEqual({ wdtt: '1.4.5+7345d56', naive: '2.11.9+e747854' });
    expect(parseBuildCheck('B:wdtt:\nB:naive:\n')).toEqual({ wdtt: '', naive: '' });
  });

  it('скрипты обновления - корректный bash', () => {
    for (const k of ['wdtt', 'naive'] as const)
      execFileSync('bash', ['-n', '-c', buildUpdateScript(k)]);
    execFileSync('bash', ['-n', '-c', BUILD_CHECK_SCRIPT]);
  });
});

let dir: string;
let db: Db;
/** Вывод скрипта проверки на сервере (command.run). */
let marks = '';
const runs: { script: string; env: Record<string, string> }[] = [];
const registry = {
  isOnline: () => true,
  request: async (
    _id: string,
    method: string,
    p: { script: string; env: Record<string, string> },
    o: { onStream?: (ch: string, chunk: string) => void },
  ) => {
    if (method !== 'command.run') throw new Error(`неожиданный вызов ${method}`);
    runs.push(p);
    if (p.script.includes('B:wdtt')) o.onStream?.('stdout', marks);
    return { exitCode: 0 };
  },
} as unknown as AgentRegistry;

function updates(sent: ServiceUpdate[] = []) {
  return new ServiceUpdates(
    db,
    {} as SecretBox,
    registry,
    { warn: () => {} },
    async (_id, x) => {
      sent.push(x);
    },
    async () => new Response('[]'),
    { filesDir: join(dir, 'files'), panelUrl: 'https://panel.example.com' },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'builds-'));
  db = createDb(dir);
  mkdirSync(join(dir, 'files', 'wdtt'), { recursive: true });
  mkdirSync(join(dir, 'files', 'naive'), { recursive: true });
  writeFileSync(join(dir, 'files', 'wdtt', 'VERSION'), '1.4.5+7345d56\n');
  writeFileSync(join(dir, 'files', 'naive', 'VERSION'), NAIVE_VERSION);
  marks = '';
  runs.length = 0;
  const inventory = {
    services: [
      { kind: 'wdtt', title: 'WDTT', ports: [] },
      { kind: 'naive', title: 'naive', ports: [] },
    ],
  };
  db.insert(servers)
    .values({ id: 's1', name: 's1', host: 'h', statusCache: { inventory } } as never)
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ServiceUpdates: сборки WDTT и прокси для браузера', () => {
  it('метки нет или она старая - обновление; совпала - строки нет', async () => {
    const sent: ServiceUpdate[] = [];
    const u = updates(sent);
    marks = 'B:wdtt:1.4.4+a296c57|\nB:naive:\n';
    const list = await u.recheck('s1');
    expect(list.map((x) => `${x.kind} ${x.current} -> ${x.latest}`)).toEqual([
      'wdtt 1.4.4+a296c57 -> 1.4.5+7345d56',
      'naive  -> 2.11.9+e747854',
    ]);
    expect(sent.map((x) => x.kind)).toEqual(['wdtt', 'naive']);

    marks = `B:wdtt:1.4.5+7345d56|\nB:naive:${NAIVE_VERSION.replace(/\n/g, '|')}\n`;
    expect(await u.recheck('s1')).toEqual([]);
  });

  it('сервиса нет или панель сборку не раздаёт - на сервер не ходим', async () => {
    rmSync(join(dir, 'files', 'wdtt'), { recursive: true });
    rmSync(join(dir, 'files', 'naive'), { recursive: true });
    expect(await updates().recheck('s1')).toEqual([]);
    expect(runs).toHaveLength(0);
  });

  it('обновление: скрипт с адресом панели, неудача - ошибка действия', async () => {
    const action = { id: 'a1', stream: () => {} } as unknown as Action;
    await updates().installBuild('s1', 'naive', action);
    expect(runs[0]?.env).toEqual({ PANEL_URL: 'https://panel.example.com' });
    expect(runs[0]?.script).toContain('/opt/vps-naive/caddy');
    const failing = {
      request: async () => ({ exitCode: 1 }),
    } as unknown as AgentRegistry;
    const u = new ServiceUpdates(
      db,
      {} as SecretBox,
      failing,
      { warn: () => {} },
      async () => {},
      async () => new Response('[]'),
      { filesDir: join(dir, 'files'), panelUrl: 'https://panel.example.com' },
    );
    await expect(u.installBuild('s1', 'wdtt', action)).rejects.toThrow('WDTT');
  });
});
