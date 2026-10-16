import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import type { Env } from '../src/config.js';
import { type Db, createDb } from '../src/db/index.js';
import { commandDefaults, servers } from '../src/db/schema.js';
import { catalogRunner } from '../src/lib/catalog-runner.js';
import { SecretBox } from '../src/lib/secret-box.js';

let dir: string;
let db: Db;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'defaults-'));
  db = createDb(dir);
  db.insert(servers)
    .values({ id: 's1', name: 'Hoster', host: '203.0.113.10', agentTokenHash: 'x' } as never)
    .run();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('ответы формы по умолчанию', () => {
  it('контейнер AWG прошлого удаления не подставляется', async () => {
    db.insert(commandDefaults)
      .values({
        serverId: 's1',
        commandId: 'awg-uninstall',
        answers: { AWG_CONTAINER: 'amnezia-awg2-40748' },
      })
      .run();
    const runner = catalogRunner({
      db,
      env: { DATA_DIR: dir, PANEL_PUBLIC_URL: 'https://panel.example.com' } as unknown as Env,
      registry: { isOnline: () => true } as unknown as AgentRegistry,
      box: new SecretBox('s'.repeat(40)),
      log: { warn: () => {} },
    });
    const d = await runner.defaults('s1', 'awg-uninstall');
    expect(d.AWG_CONTAINER ?? '').toBe('');
  });
});
