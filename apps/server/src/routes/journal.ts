import type { ActionListRow } from '@vps/protocol';
import { desc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actionLog } from '../db/schema.js';
import type { ServerRouteOpts } from '../lib/action-runners.js';

const Id = z.object({ id: z.string() });

/** Журнал действий: списки (без вывода) и одно действие с выводом. */
export async function journalRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db } = opts;

  // Списки - без вывода (до 1 МБ на запись): его показывает окно действия через
  // /api/actions/:aid, а списки обновляются после каждого действия.
  const listColumns = {
    id: actionLog.id,
    serverId: actionLog.serverId,
    kind: actionLog.kind,
    params: actionLog.params,
    startedAt: actionLog.startedAt,
    finishedAt: actionLog.finishedAt,
    exitCode: actionLog.exitCode,
  };
  app.get('/api/servers/:id/actions', async (req): Promise<ActionListRow[]> => {
    const { id } = Id.parse(req.params);
    return db
      .select(listColumns)
      .from(actionLog)
      .where(eq(actionLog.serverId, id))
      .orderBy(desc(actionLog.startedAt))
      .limit(100);
  });
  app.get('/api/actions/:aid', async (req, reply) => {
    const { aid } = z.object({ aid: z.string() }).parse(req.params);
    const row = (await db.select().from(actionLog).where(eq(actionLog.id, aid)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: 'Не найдено' });
    return row;
  });
  app.get('/api/actions', async (): Promise<ActionListRow[]> => {
    return db.select(listColumns).from(actionLog).orderBy(desc(actionLog.startedAt)).limit(200);
  });
}
