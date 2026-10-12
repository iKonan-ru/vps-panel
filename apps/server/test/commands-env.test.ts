import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { commandRoutes } from '../src/routes/commands.js';

/** Окружение скрипта команды: CLIENT_HOST - имя из "Адреса для клиентов", если задано. */
async function preflightEnv(clientHost: string | null) {
  const db = createDb(':memory:');
  db.insert(servers)
    .values({ id: 's1', name: 'NetCore', host: '203.0.113.10', clientHost } as never)
    .run();
  let seen: Record<string, string> = {};
  const registry = {
    isOnline: () => true,
    request: async (_id: string, _op: string, p: { env: Record<string, string> }) => {
      seen = p.env;
      return { exitCode: 0, tail: '' };
    },
  };
  const app = Fastify();
  await app.register(commandRoutes, {
    db,
    env: { PANEL_PUBLIC_URL: 'https://panel.example.com', AGENT_DIR: '/nonexistent' } as never,
    registry: registry as never,
    hub: {} as never,
    box: {} as never,
  });
  const r = await app.inject({
    method: 'POST',
    url: '/api/servers/s1/commands/mtproxyl/preflight',
    payload: {},
  });
  expect(r.statusCode).toBe(200);
  await app.close();
  return seen;
}

describe('окружение команд', () => {
  it('CLIENT_HOST - имя сервера для клиентов, без имени - IP', async () => {
    expect((await preflightEnv('netcore.example.com')).CLIENT_HOST).toBe('netcore.example.com');
    expect((await preflightEnv(null)).CLIENT_HOST).toBe('203.0.113.10');
  });
});
