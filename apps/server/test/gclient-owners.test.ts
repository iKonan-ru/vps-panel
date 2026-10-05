import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GOwner } from '@vps/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, gclientBindings, gclientDevices, gclients, servers } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';
import { wdttKey } from '../src/lib/gclient-services.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-owners-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  await built.app.ready();
  const { db } = built;
  db.insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  cookie = `vps_session=${(await createSession(db, 'a1', '127.0.0.1', 't')).token}`;
  db.insert(servers)
    .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
    .run();
  db.insert(gclients)
    .values([
      { id: 'c1', name: 'Иван', slug: 'ivan', token: 't1', xuiSubId: 'x1' },
      { id: 'c2', name: 'Удалён', slug: 'gone', token: 't2', xuiSubId: 'x2', deletedAt: 'now' },
    ])
    .run();
  db.insert(gclientDevices).values({ id: 'd1', clientId: 'c1', name: 'Пиксель' }).run();
  const b = (id: string, clientId: string, service: string, ref: string, deviceId?: string) => ({
    id,
    clientId,
    serverId: 's1',
    service,
    ref,
    deviceId: deviceId ?? null,
  });
  db.insert(gclientBindings)
    .values([
      b('b1', 'c1', 'xui', 'ivan'),
      b('b2', 'c1', 'awg', '3|amnezia-awg2|KEY1', 'd1'),
      b('b3', 'c1', 'awg', '2||', 'd1'),
      b('b4', 'c1', 'openflux', 'vp-0123456789ab', 'd1'),
      { ...b('b5', 'c1', 'wdtt', 'ivan'), secret: 'pass-1' },
      b('b6', 'c2', 'mtproxyl', 'gone'),
    ])
    .run();
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('чьи записи в сервисах сервера', () => {
  it('ключи по сервисам (WDTT - хеш пароля), без удалённых клиентов и пиров без ключа', async () => {
    const res = await built.app.inject({
      method: 'GET',
      url: '/api/servers/s1/gclient-owners',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as GOwner[];
    expect(rows.map((r) => `${r.service}:${r.key}:${r.device}`).sort()).toEqual([
      'awg:KEY1:Пиксель',
      'openflux:vp-0123456789ab:Пиксель',
      `wdtt:${wdttKey('pass-1')}:`,
      'xui:ivan:',
    ]);
    expect(rows.every((r) => r.clientId === 'c1' && r.client === 'Иван')).toBe(true);
  });

  it('ключ WDTT - хеш, не пароль', () => {
    expect(wdttKey('secret-password')).toMatch(/^[0-9a-f]{16}$/);
    expect(wdttKey('secret-password')).not.toContain('secret');
  });

  it('клиента панели во вкладке 3X-UI не удалить - 409 с подсказкой про карточку', async () => {
    const res = await built.app.inject({
      method: 'DELETE',
      url: '/api/servers/s1/xui/clients/ivan',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('карточке');
  });

  it('полная сверка ставит в очередь все привязки, по клиенту - только его', async () => {
    const pending = () =>
      built.db
        .select()
        .from(gclientBindings)
        .all()
        .filter((b) => b.state === 'pending').length;
    built.db.update(gclientBindings).set({ state: 'ok' }).run();
    const one = await built.app.inject({
      method: 'POST',
      url: '/api/gclients/sync',
      headers: { cookie },
      payload: { clientId: 'c2' },
    });
    expect(one.statusCode).toBe(200);
    expect(pending()).toBe(1);
    await built.app.inject({
      method: 'POST',
      url: '/api/gclients/sync',
      headers: { cookie },
      payload: { all: true },
    });
    expect(pending()).toBe(6);
    const st = await built.app.inject({
      method: 'GET',
      url: '/api/gclients/syncing',
      headers: { cookie },
    });
    expect(typeof st.json().syncing).toBe('boolean');
  });

  it('без входа - 401', async () => {
    const res = await built.app.inject({ method: 'GET', url: '/api/servers/s1/gclient-owners' });
    expect(res.statusCode).toBe(401);
  });
});
