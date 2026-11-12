import Fastify from 'fastify';
import { expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { serverRoutes } from '../src/routes/servers.js';

it('сохранение имени и тегов независимо от смены SSH-порта', async () => {
  const db = createDb(':memory:');
  db.insert(servers)
    .values({
      id: 's',
      name: 'Hoster',
      host: '203.0.113.5',
      sshPort: 24567,
      agentTokenHash: 'hash',
    })
    .run();
  const app = Fastify();
  await app.register(serverRoutes, {
    db,
    registry: {} as never,
    env: {} as never,
    hub: { broadcast: () => {} } as never,
    conns: {} as never,
  });
  const patch = (payload: Record<string, unknown>) =>
    app.inject({ method: 'PATCH', url: '/api/servers/s', payload });
  try {
    expect((await patch({ name: 'Hoster', tags: ['vpn'] })).statusCode).toBe(200);
    expect((await patch({ name: 'NetCore' })).statusCode).toBe(200);
    expect((await patch({ sshPort: 22 })).statusCode).toBe(409);
    expect((await patch({})).statusCode).toBe(400);
    expect(db.select().from(servers).get()).toMatchObject({
      name: 'NetCore',
      tags: ['vpn'],
      sshPort: 24567,
    });
    expect((await patch({ tags: [] })).statusCode).toBe(200);
    expect(db.select().from(servers).get()?.tags).toEqual([]);
  } finally {
    await app.close();
  }
});
