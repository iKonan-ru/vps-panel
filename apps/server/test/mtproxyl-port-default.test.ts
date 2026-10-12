import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, servers } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-mtport-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

/** Снимок сервера: сервисы и слушающие TCP-порты (процесс - как у агента). */
const inv = (kinds: string[], listeners: [number, string][]) => ({
  inventory: {
    services: kinds.map((kind) => ({ kind, title: kind, ports: [] })),
    firewall: {
      listeners: listeners.map(([port, process]) => ({ proto: 'tcp', port, process, open: true })),
    },
  },
});

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  await built.app.ready();
  const { db } = built;
  db.insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  cookie = `vps_session=${(await createSession(db, 'a1', '127.0.0.1', 't')).token}`;
  db.insert(servers)
    .values([
      { id: 'free', name: 'free', host: '1.1.1.1', statusCache: inv([], [[22, 'sshd']]) },
      {
        id: 'xui',
        name: 'xui',
        host: '1.1.1.2',
        statusCache: inv(
          ['xui'],
          [
            [443, 'xray-linux-amd64'],
            [993, 'nginx'],
          ],
        ),
      },
      {
        id: 'naive',
        name: 'naive',
        host: '1.1.1.3',
        statusCache: inv(['naive'], [[443, 'caddy']]),
      },
    ] as never)
    .run();
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

async function port(id: string) {
  const r = await built.app.inject({
    method: 'GET',
    url: `/api/servers/${id}/commands/mtproxyl/defaults`,
    headers: { cookie },
  });
  return (r.json() as { MT_PORT: string }).MT_PORT;
}

describe('MTProxyL: порт прокси в форме', () => {
  it('443 свободен - 443', async () => {
    expect(await port('free')).toBe('443');
  });
  it('443 занят Xray, 993 занят - первый свободный из запасных', async () => {
    expect(await port('xui')).toBe('8443');
  });
  it('443 у прокси для браузера - всё равно 443 (MTProxyL забирает его сам)', async () => {
    expect(await port('naive')).toBe('443');
  });
});
