import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.js';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { admins, servers } from '../src/db/schema.js';
import { createSession } from '../src/lib/auth.js';

const dir = mkdtempSync(join(tmpdir(), 'vps-term-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
let built: Awaited<ReturnType<typeof buildApp>>;
let cookie = '';
/** Что "агент" записал в терминал - в порядке записи, а не отправки. */
const written: string[] = [];
const calls: string[] = [];

beforeAll(async () => {
  const registry = new AgentRegistry();
  let n = 0;
  registry.isOnline = () => true;
  registry.request = ((_id: string, method: string, params: { data?: string }) => {
    calls.push(method);
    if (method === 'term.open') return new Promise(() => undefined);
    if (method !== 'term.input') return Promise.resolve({ ok: true });
    // агент выполняет запросы параллельно: ранние нажатия дольше в пути и обгоняются поздними
    const delay = Math.max(1, 40 - n++ * 8);
    return new Promise<unknown>((r) =>
      setTimeout(() => {
        written.push(Buffer.from(params.data ?? '', 'base64').toString());
        r({ ok: true });
      }, delay),
    );
  }) as unknown as AgentRegistry['request'];
  built = await buildApp({ env, db: createDb(':memory:'), registry });
  await built.app.ready();
  built.db
    .insert(admins)
    .values({ id: 'a1', login: 'admin', passwordHash: 'x' } as never)
    .run();
  built.db
    .insert(servers)
    .values({ id: 's1', name: 's1', host: '203.0.113.1' } as never)
    .run();
  cookie = `vps_session=${(await createSession(built.db, 'a1', '127.0.0.1', 't')).token}`;
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('веб-терминал: ввод', () => {
  it('быстрые нажатия доходят до терминала по порядку', async () => {
    const got: string[] = [];
    const ws = await built.app.injectWS(
      '/ws/term/s1',
      { headers: { cookie } },
      {
        onInit: (w) => {
          w.on('message', (m) => got.push(`MSG ${String(m)}`));
          w.on('close', (c, r) => got.push(`CLOSE ${c} ${String(r)}`));
        },
      },
    );
    await new Promise((r) => setTimeout(r, 50));
    for (const ch of 'clear; ss -ltnp\r')
      ws.send(JSON.stringify({ t: 'input', d: Buffer.from(ch).toString('base64') }));
    await new Promise((r) => setTimeout(r, 400));
    expect(got.filter((g) => g.startsWith('CLOSE'))).toEqual([]);
    expect(calls.filter((c) => c === 'term.input').length).toBeLessThan(16);
    expect(written.join('')).toBe('clear; ss -ltnp\r');
    ws.terminate();
  });
});
