import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import type { UiHub } from '../lib/ui-hub.js';
import { foreignOrigin, sessionOf, sessionToken } from './auth.js';

/**
 * /ws/ui: websocket для браузера, авторизация той же cookie, что и API.
 * Только сервер -> браузер; клиент ничего не шлёт, кроме ping.
 */
export async function uiWsRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; hub: UiHub },
) {
  const { db, registry, hub } = opts;

  registry.on('online', (serverId) => hub.broadcast({ type: 'server.online', serverId }));
  registry.on('offline', (serverId) => hub.broadcast({ type: 'server.offline', serverId }));
  // цифры - в самом событии: браузер обновляет их без запроса
  registry.on('metrics', (serverId, metrics) =>
    hub.broadcast({ type: 'server.metrics', serverId, metrics }),
  );
  registry.on('inventory', (serverId) => hub.broadcast({ type: 'server.inventory', serverId }));

  app.get('/ws/ui', { websocket: true }, async (socket, req) => {
    const s = await sessionOf(db, sessionToken(req));
    if (!s) return socket.close(4001, 'unauthorized');
    if (foreignOrigin(req)) return socket.close(4003, 'foreign origin');
    hub.add(socket);
    socket.send(JSON.stringify({ type: 'hello', online: registry.onlineIds() }));
  });
}
