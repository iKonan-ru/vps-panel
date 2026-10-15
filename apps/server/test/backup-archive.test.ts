import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import Fastify from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import type { Env } from '../src/config.js';
import { type Db, createDb } from '../src/db/index.js';
import { backups, servers } from '../src/db/schema.js';
import { readArchiveManifest } from '../src/lib/backup-archive.js';
import { BackupRestorer } from '../src/lib/backup-restore.js';
import { opensslDecrypt, opensslEncrypt } from '../src/lib/panel-backup.js';
import { backupRoutes } from '../src/routes/backups.js';

/** tar из файлов (имя -> содержимое), как пишет агент: обычные файлы, два нулевых блока в конце. */
function tar(files: [string, Buffer | string][]): Buffer {
  const parts: Buffer[] = [];
  for (const [name, body] of files) {
    const data = Buffer.from(body);
    const h = Buffer.alloc(512);
    h.write(name, 0, 'utf8');
    h.write('0000600\0', 100, 'ascii');
    h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    h.write('0', 156, 'ascii');
    parts.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

const SETUP = { serverName: 'Hoster', services: ['xui'], answers: {}, awg: [], clientHost: null };

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bk-'));
  db = createDb(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('manifest.json из архива копии', () => {
  it('находит manifest.json после больших файлов', async () => {
    const f = join(dir, 'a.tar.gz');
    writeFileSync(
      f,
      gzipSync(
        tar([
          ['etc/x-ui/x-ui.db', Buffer.alloc(300_000, 7)],
          [
            'manifest.json',
            JSON.stringify({ hostname: 'h', components: [{ id: 'xui' }], setup: SETUP }),
          ],
        ]),
      ),
    );
    expect(await readArchiveManifest(f)).toMatchObject({ hostname: 'h', setup: SETUP });
  });

  it('нет manifest.json или не gzip - null', async () => {
    const a = join(dir, 'a.tar.gz');
    writeFileSync(a, gzipSync(tar([['x', 'y']])));
    expect(await readArchiveManifest(a)).toBeNull();
    const b = join(dir, 'b.tar.gz');
    writeFileSync(b, 'not gzip');
    expect(await readArchiveManifest(b)).toBeNull();
  });
});

describe('загрузка файла копии', () => {
  let pass: string | null = 'backup-pass-1';
  beforeEach(() => {
    pass = 'backup-pass-1';
  });
  async function app() {
    db.insert(servers)
      .values({ id: 's1', name: 'New', host: '203.0.113.1' } as never)
      .run();
    const env = { DATA_DIR: dir, PANEL_PUBLIC_URL: 'https://panel.example.com' } as unknown as Env;
    const registry = { isOnline: () => true } as unknown as AgentRegistry;
    const a = Fastify();
    await a.register(backupRoutes, {
      db,
      env,
      registry,
      hub: { broadcast: () => {} } as never,
      restorer: new BackupRestorer(db, env, registry),
      password: () => pass,
    });
    return a;
  }
  const upload = (a: Awaited<ReturnType<typeof app>>, body: Buffer) =>
    a.inject({
      method: 'POST',
      url: '/api/servers/s1/backups/upload',
      headers: { 'content-type': 'application/gzip' },
      payload: body,
    });

  it('копия с составом - копия этого сервера', async () => {
    const a = await app();
    const r = await upload(
      a,
      gzipSync(
        tar([
          [
            'manifest.json',
            JSON.stringify({
              hostname: 'old',
              createdAt: '2026-10-15T10:00:00Z',
              components: [{ id: 'xui' }],
              setup: SETUP,
            }),
          ],
        ]),
      ),
    );
    expect(r.statusCode).toBe(200);
    const row = db.select().from(backups).get();
    expect(row).toMatchObject({
      id: r.json().id,
      serverId: 's1',
      serverName: 'Hoster',
      hostname: 'old',
    });
    expect(row?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('копия до 1.6 без состава и чужой архив - отказ, файл не остаётся', async () => {
    const a = await app();
    const old = await upload(
      a,
      gzipSync(tar([['manifest.json', JSON.stringify({ hostname: 'old', components: [] })]])),
    );
    expect(old.statusCode).toBe(400);
    expect(JSON.stringify(old.json())).toMatch(/до версии 1\.6/);
    const junk = await upload(a, gzipSync(tar([['x', 'y']])));
    expect(junk.statusCode).toBe(400);
    expect(db.select().from(backups).all()).toHaveLength(0);
  });

  const archive = () =>
    gzipSync(
      tar([
        ['etc/x-ui/x-ui.db', Buffer.alloc(70_000, 3)],
        [
          'manifest.json',
          JSON.stringify({ hostname: 'old', components: [{ id: 'xui' }], setup: SETUP }),
        ],
      ]),
    );

  it('скачивание - зашифровано паролем копий, загрузка зашифрованного - обратно', async () => {
    const a = await app();
    const plain = archive();
    const up = await upload(a, plain);
    expect(up.statusCode).toBe(200);
    const id = up.json().id as string;
    const dl = await a.inject({ method: 'GET', url: `/api/backups/${id}/download` });
    expect(dl.statusCode).toBe(200);
    expect(dl.headers['content-disposition']).toMatch(/\.tar\.gz\.enc"/);
    const enc = dl.rawPayload;
    expect(Number(dl.headers['content-length'])).toBe(enc.length);
    expect(enc.subarray(0, 8).toString()).toBe('Salted__');
    // формат openssl: расшифровывается тем же паролем
    expect(opensslDecrypt(enc, 'backup-pass-1').equals(plain)).toBe(true);
    // загрузка зашифрованного файла
    const again = await a.inject({
      method: 'POST',
      url: '/api/servers/s1/backups/upload',
      headers: { 'content-type': 'application/octet-stream' },
      payload: enc,
    });
    expect(again.statusCode).toBe(200);
    expect(
      db
        .select()
        .from(backups)
        .all()
        .map((b) => b.sha256),
    ).toEqual([expect.any(String), db.select().from(backups).all()[0]?.sha256]);
    // PBKDF2 100 000 итераций несколько раз: под нагрузкой проверок дольше 5 с
  }, 30_000);

  it('чужой пароль или пароль не задан - отказ', async () => {
    const a = await app();
    const enc = opensslEncrypt(archive(), 'other-pass');
    const bad = await upload(a, enc);
    expect(bad.statusCode).toBe(400);
    expect(JSON.stringify(bad.json())).toMatch(/другим паролем/);
    pass = null;
    const none = await upload(a, opensslEncrypt(archive(), 'x'));
    expect(none.statusCode).toBe(409);
    const up = await upload(a, archive());
    const dl = await a.inject({ method: 'GET', url: `/api/backups/${up.json().id}/download` });
    expect(dl.statusCode).toBe(409);
    expect(db.select().from(backups).all()).toHaveLength(1);
    // PBKDF2 100 000 итераций несколько раз: под нагрузкой проверок дольше 5 с
  }, 30_000);
});
