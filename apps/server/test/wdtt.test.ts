import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import { wdttLinks } from '../src/lib/wdtt.js';
import { wdttRoutes } from '../src/routes/wdtt.js';

describe('wdttLinks', () => {
  it('qwdtt:// с %20 вместо "+", старая wdtt://, IPv6 в скобках', () => {
    const l = wdttLinks({
      host: '1.2.3.4',
      dtlsPort: 56000,
      wgPort: 56001,
      password: 'p@ss',
      hashes: ['h1', 'h2'],
      name: 'Швеция :: Hoster',
    });
    expect(l.qwdtt).toBe(
      `qwdtt://config?name=${encodeURIComponent('Швеция :: Hoster')}&peer=1.2.3.4%3A56000&hashes=h1%2Ch2&workers=9&port=9000&pass=p%40ss`,
    );
    expect(l.qwdtt).not.toContain('+');
    expect(l.wdtt).toBe('wdtt://1.2.3.4:56000:56001:9000:p@ss:h1,h2');
    const v6 = wdttLinks({
      host: '::1',
      dtlsPort: 1,
      wgPort: 2,
      password: 'x',
      hashes: [],
      name: 'n',
    });
    expect(v6.wdtt).toBe('wdtt://[::1]:1:2:9000:x:');
  });
});

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wdtt-'));
  db = createDb(dir);
  db.insert(servers)
    .values({ id: 's1', name: 'b', host: '1.1.1.1', provider: 'Hoster', country: 'SE' } as never)
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('маршруты WDTT', () => {
  it('список со ссылками; создание с хешем "-"; в журнале нет пароля', async () => {
    const calls: { path: string; form: Record<string, string> }[] = [];
    const registry = {
      isOnline: () => true,
      refreshInventory: () => {},
      request: async (
        _id: string,
        _m: string,
        p: { path: string; form: Record<string, string> },
      ) => {
        calls.push(p);
        if (p.path === '/admin/passwords' && !p.form.label)
          return {
            status: 200,
            dtlsPort: 56000,
            wgPort: 56001,
            data: {
              passwords: [{ password: 'secret1', label: 'Иван', max_devices: 2, device_ids: null }],
            },
          };
        return { status: 200, dtlsPort: 56000, wgPort: 56001, data: {} };
      },
    };
    const app = Fastify();
    await app.register(wdttRoutes, {
      db,
      registry: registry as never,
      hub: { broadcast: () => {} } as never,
      gc: { kick: () => {} } as never,
    });

    const list = await app.inject({ method: 'GET', url: '/api/servers/s1/wdtt' });
    expect(list.json().passwords[0].links.wdtt).toBe('wdtt://1.1.1.1:56000:56001:9000:secret1:');
    // новый пароль без устройств: у сервера null, у панели - пустой список
    expect(list.json().passwords[0].device_ids).toEqual([]);

    await app.inject({
      method: 'POST',
      url: '/api/servers/s1/wdtt/passwords',
      payload: { label: 'Пётр', maxDevices: 3, days: 365 },
    });
    expect(calls.at(-1)?.form).toEqual({
      label: 'Пётр',
      max_devices: '3',
      days: '365',
      vk_hash: '-',
    });

    await app.inject({
      method: 'POST',
      url: '/api/servers/s1/wdtt/passwords/unbind-device',
      payload: { password: 'secret1', label: 'Иван', deviceId: 'dev-1' },
    });
    expect(calls.at(-1)).toMatchObject({
      path: '/admin/passwords/unbind-device',
      form: { password: 'secret1', device_id: 'dev-1' },
    });
    expect(JSON.stringify(db.select().from(actionLog).all())).not.toContain('secret1');
    await app.close();
  });
});
