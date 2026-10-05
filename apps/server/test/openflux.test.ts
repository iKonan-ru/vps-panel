import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
import { createAdmin, createSession } from '../src/lib/auth.js';
import { ofChannelName } from '../src/lib/gclient-services.js';
import { addOfDocs, ofDocKind, releaseOfDocs, takeOfDocs } from '../src/lib/openflux-docs.js';

// OpenFlux: имя канала клиента и проверка входа маршрутов
const dir = mkdtempSync(join(tmpdir(), 'vps-of-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
const db = createDb(':memory:');
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let cookie = '';

beforeAll(async () => {
  ({ app } = await buildApp({ env, db }));
  await app.ready();
  const a = await createAdmin(db, 'admin', 'password-123');
  cookie = `vps_session=${(await createSession(db, a.id, '127.0.0.1', 'test')).token}`;
});
afterAll(async () => {
  await app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('OpenFlux', () => {
  it('имя канала устройства - в формате node-install.sh и одно и то же при каждой сверке', () => {
    const n = ofChannelName('dev-ABC_123');
    expect(n).toMatch(/^[a-z0-9][a-z0-9-]{0,30}$/);
    expect(n).toBe(ofChannelName('dev-ABC_123'));
    expect(n).not.toBe(ofChannelName('dev-ABC_124'));
  });

  it('плохое имя канала и чужая ссылка документа не уходят агенту', async () => {
    const post = (json: unknown) =>
      app.inject({
        method: 'POST',
        url: '/api/servers/x/openflux/exec',
        headers: { cookie },
        payload: json as Record<string, unknown>,
      });
    for (const bad of [
      { op: 'restart', channel: '-rf' },
      { op: 'remove', channel: 'a b' },
      { op: 'create', vyandex: 'https://evil.example/edit/d/x' },
      { op: 'create', mailru: 'https://cloud.mail.ru/public/a\nkey=1/b' },
      { op: 'uninstall' },
    ])
      expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    // правильный запрос доходит до проверки агента (его нет в сети)
    expect((await post({ op: 'restart', channel: 'of-abc123' })).statusCode).toBe(409);
    expect((await post({ op: 'create', cupsonline: 'auto' })).statusCode).toBe(409);
  });

  it('ссылки документов: чистка и вид', () => {
    expect(ofDocKind(' https://docs.yandex.ru/edit/d/AbCdEfGhIjKlMnOp12?x=1#y ')).toEqual({
      kind: 'vyandex',
      url: 'https://docs.yandex.ru/edit/d/AbCdEfGhIjKlMnOp12',
    });
    expect(ofDocKind('https://cloud.mail.ru/public/Ab12/Cd34/')?.kind).toBe('mailru');
    expect(ofDocKind('https://docs.yandex.ru/edit/d/short')).toBeNull();
    expect(ofDocKind('https://evil.example/public/a/b')).toBeNull();
  });

  it('пул: документ выдаётся одному каналу и возвращается после удаления', () => {
    db.insert(servers).values({ id: 's1', name: 'S', host: '1.2.3.4' }).run();
    db.insert(gclients)
      .values({ id: 'c1', name: 'C', slug: 'c', token: 't'.repeat(32) })
      .run();
    for (const id of ['b1', 'b2'])
      db.insert(gclientBindings)
        .values({ id, clientId: 'c1', serverId: 's1', service: 'openflux', ref: `vp-${id}` })
        .run();
    const r = addOfDocs(
      db,
      'https://docs.yandex.ru/edit/d/AbCdEfGhIjKlMnOp12\nмусор\nhttps://docs.yandex.ru/edit/d/AbCdEfGhIjKlMnOp12',
    );
    expect(r).toEqual({ added: 1, bad: ['мусор'] });
    const a = takeOfDocs(db, 'b1');
    expect(a.vyandex).toContain('AbCdEf');
    expect(takeOfDocs(db, 'b1')).toEqual(a); // тот же при повторе
    expect(takeOfDocs(db, 'b2').vyandex).toBe(''); // занят
    releaseOfDocs(db, 'b1');
    expect(takeOfDocs(db, 'b2').vyandex).toBe(a.vyandex);
  });
});
