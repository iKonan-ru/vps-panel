import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, gclients } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';
import { newClientToken, newXuiSubId } from '../src/lib/gclient-names.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-rotate-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir, SUB_DOMAIN: 'sub.example' });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
const oldToken = newClientToken();
const subId = newXuiSubId();

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  await built.app.ready();
  built.db
    .insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  cookie = `vps_session=${(await createSession(built.db, 'a1', '127.0.0.1', 't')).token}`;
  built.db
    .insert(gclients)
    .values({ id: 'c1', name: 'Иван', slug: 'ivan-0001', token: oldToken, xuiSubId: subId })
    .run();
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('новая ссылка клиента', () => {
  it('новый токен, старая ссылка перестаёт работать, subId 3X-UI не меняется', async () => {
    expect((await built.app.inject({ method: 'GET', url: `/c/${oldToken}` })).statusCode).toBe(200);
    const res = await built.app.inject({
      method: 'POST',
      url: '/api/gclients/c1/rotate-token',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const { url, page } = res.json() as { url: string; page: string };
    const row = built.db.select().from(gclients).where(eq(gclients.id, 'c1')).get();
    expect(row?.token).not.toBe(oldToken);
    expect(row?.token).toMatch(/^[0-9a-f]{32}$/);
    expect(row?.xuiSubId).toBe(subId);
    expect(url).toBe(`https://sub.example/sub/${row?.token}`);
    expect(page).toBe(`https://sub.example/c/${row?.token}`);
    expect((await built.app.inject({ method: 'GET', url: `/c/${oldToken}` })).statusCode).toBe(404);
    expect((await built.app.inject({ method: 'GET', url: `/sub/${oldToken}` })).statusCode).toBe(
      404,
    );
    expect((await built.app.inject({ method: 'GET', url: `/c/${row?.token}` })).statusCode).toBe(
      200,
    );
  });

  it('без входа - 401', async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/gclients/c1/rotate-token' });
    expect(res.statusCode).toBe(401);
  });
});
