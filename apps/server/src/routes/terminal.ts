import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { foreignOrigin, sessionOf, sessionToken } from './auth.js';

/**
 * /ws/term/:serverId - веб-терминал: браузер <-> панель (websocket) <-> агент (term.*).
 * Вывод агента (base64) пересылается как есть, ввод и размер уходят отдельными запросами.
 * Каждая сессия пишется в журнал действий (когда открыли и закрыли).
 */
export async function terminalRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry },
) {
  const { db, registry } = opts;

  app.get('/ws/term/:serverId', { websocket: true }, async (socket, req) => {
    const s = await sessionOf(db, sessionToken(req));
    if (!s) return socket.close(4001, 'unauthorized');
    if (foreignOrigin(req)) return socket.close(4003, 'foreign origin');
    const { serverId } = req.params as { serverId: string };
    if (!registry.isOnline(serverId)) return socket.close(4009, 'agent offline');
    const url = new URL(req.url, 'http://x');
    const cols = Math.min(Math.max(Number(url.searchParams.get('cols')) || 120, 20), 400);
    const rows = Math.min(Math.max(Number(url.searchParams.get('rows')) || 32, 5), 200);

    const sid = newId();
    const actionId = newId();
    await db.insert(actionLog).values({
      id: actionId,
      serverId,
      kind: 'terminal',
      params: { login: s.login },
    });
    let bytes = 0;
    const send = (o: unknown) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(o));
    };
    const finish = async (note: string) => {
      await db
        .update(actionLog)
        .set({ finishedAt: new Date().toISOString(), exitCode: 0, output: note })
        .where(eq(actionLog.id, actionId));
    };

    registry
      .request(
        serverId,
        'term.open',
        { id: sid, cols, rows },
        {
          timeoutMs: 24 * 60 * 60_000,
          onStream: (_channel, chunk) => {
            bytes += chunk.length;
            send({ t: 'data', d: chunk });
          },
        },
      )
      .then((r) => {
        send({ t: 'exit', code: (r as { exitCode?: number })?.exitCode ?? 0 });
        socket.close(1000, 'shell exited');
      })
      .catch((e: Error) => {
        send({ t: 'error', m: e.message });
        socket.close(1011, 'agent error');
      })
      .finally(
        () =>
          void finish(`Терминал закрыт, передано ${Math.round((bytes * 3) / 4 / 1024)} КБ вывода`),
      );

    socket.on('message', (raw) => {
      let m: { t: string; d?: string; cols?: number; rows?: number };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (m.t === 'input' && typeof m.d === 'string') {
        registry
          .request(serverId, 'term.input', { id: sid, data: m.d }, { timeoutMs: 10_000 })
          .catch(() => undefined);
      } else if (m.t === 'resize' && m.cols && m.rows) {
        registry
          .request(
            serverId,
            'term.resize',
            { id: sid, cols: m.cols, rows: m.rows },
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined);
      }
    });
    socket.on('close', () => {
      registry
        .request(serverId, 'term.close', { id: sid }, { timeoutMs: 10_000 })
        .catch(() => undefined);
    });
  });
}
