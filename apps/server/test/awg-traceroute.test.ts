import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { AGENT_OUTDATED, AgentError } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { actionLog, servers } from '../src/db/schema.js';
import { awgRoutes } from '../src/routes/awg.js';

/** Маршрут скрытия узла AWG в трассировке с имитацией агента. */
async function setup(o: { online?: boolean; supports?: boolean } = {}) {
  const db = createDb(':memory:');
  db.insert(servers).values({ id: 's1', name: 'Hoster', host: '203.0.113.10' }).run();
  const calls: Record<string, unknown>[] = [];
  const registry = {
    isOnline: () => o.online ?? true,
    supports: () => o.supports ?? true,
    refreshInventory: async () => undefined,
    request: async (_id: string, method: string, p: Record<string, unknown>) => {
      if (method !== 'awg.traceroute.set') throw new Error(method);
      if (o.supports === false) throw new AgentError(AGENT_OUTDATED, 'outdated');
      calls.push(p);
      return { configured: p.enabled, applied: p.enabled };
    },
  };
  const app = Fastify();
  // как общий обработчик приложения: ошибка схемы - 400, ошибка агента - её код
  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'неверные данные' });
    const e = err as { statusCode?: number; message: string };
    return reply.code(e.statusCode ?? 500).send({ error: e.message });
  });
  await app.register(awgRoutes, {
    db,
    registry: registry as never,
    hub: { broadcast: () => {} } as never,
    box: {} as never,
    env: {} as never,
    engines: {} as never,
    conns: {} as never,
  });
  const put = (payload: unknown) =>
    app.inject({
      method: 'PUT',
      url: '/api/servers/s1/awg/traceroute',
      payload: payload as object,
    });
  return { db, app, calls, put };
}

describe('скрытие узла AWG в трассировке', () => {
  it('включение - действие сервера с проверенным состоянием в ответе', async () => {
    const { db, calls, put } = await setup();
    const r = await put({ container: 'amnezia-awg2', enabled: true });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ configured: true, applied: true });
    expect(calls).toEqual([{ container: 'amnezia-awg2', enabled: true }]);
    const a = db.select().from(actionLog).get();
    expect(a).toMatchObject({ kind: 'awg:traceroute', exitCode: 0, serverId: 's1' });
  });

  it('строгий boolean и имя контейнера проверяются до агента', async () => {
    const { calls, put } = await setup();
    expect((await put({ container: 'amnezia-awg2', enabled: 'true' })).statusCode).toBe(400);
    expect((await put({ container: 'amnezia-awg2' })).statusCode).toBe(400);
    expect((await put({ container: 'x; reboot', enabled: true })).statusCode).toBe(400);
    expect((await put({ container: 'amnezia-awg2-51820', enabled: false })).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
  });

  it('старый агент - 409 с просьбой обновить; сервер не в сети - 409', async () => {
    let r = await (await setup({ supports: false })).put({
      container: 'amnezia-awg2',
      enabled: true,
    });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toContain('обновить агент');
    r = await (await setup({ online: false })).put({ container: 'amnezia-awg2', enabled: true });
    expect(r.statusCode).toBe(409);
  });
});
