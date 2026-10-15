import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { desc, eq, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import { CATALOG, findCommand, validateAnswers } from '../commands/index.js';
import { toInfo } from '../commands/types.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { catalogRunner } from '../lib/catalog-runner.js';
import { downloadRateLimit, fileSha256, sendFile } from '../lib/file-send.js';
import type { PanelCerts } from '../lib/panel-certs.js';
import type { SecretBox } from '../lib/secret-box.js';
import type { UiHub } from '../lib/ui-hub.js';

const Answers = z.record(z.string(), z.string().max(4000));

/**
 * Команды каталога: список, значения по умолчанию, проверки перед запуском,
 * запуск со стримом, отмена, файлы для скриптов (/files/...).
 */
export async function commandRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    env: Env;
    registry: AgentRegistry;
    hub: UiHub;
    box: SecretBox;
    certs?: PanelCerts;
  },
) {
  const { db, env, registry, hub, box, certs } = opts;
  const journal = actionJournal(db, hub, registry);
  const runner = catalogRunner({ db, env, registry, box, certs, log: app.log });

  app.get('/api/commands', async () => CATALOG.map(toInfo));

  /** Значения по умолчанию для формы: сохранённые ответы для сервера поверх default/generate. */
  app.get('/api/servers/:id/commands/:cmd/defaults', async (req) => {
    const { id, cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    return runner.defaults(id, cmd);
  });

  /** План "что будет сделано" по текущим ответам. */
  app.post('/api/servers/:id/commands/:cmd/plan', async (req, reply) => {
    const { cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    const c = findCommand(cmd);
    if (!c) return reply.code(404).send({ error: 'команда не найдена' });
    const answers = Answers.parse(req.body ?? {});
    return { steps: c.plan(answers), errors: validateAnswers(c, answers) };
  });

  /** Быстрые проверки на сервере: строки OK|, WARN|, FAIL|. */
  app.post('/api/servers/:id/commands/:cmd/preflight', async (req) => {
    const { id, cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    return runner.preflight(id, cmd, Answers.parse(req.body ?? {}));
  });

  /** Запуск: действие command:<id> со стримом вывода. */
  app.post('/api/servers/:id/commands/:cmd/run', async (req) => {
    const { id, cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    const actionId = await runner.start(journal, id, cmd, Answers.parse(req.body ?? {}));
    return { actionId };
  });

  /** Остановить выполняющуюся команду. */
  app.post('/api/actions/:aid/cancel', async (req, reply) => {
    const { aid } = z.object({ aid: z.string() }).parse(req.params);
    const row = (await db.select().from(actionLog).where(eq(actionLog.id, aid)).limit(1))[0];
    if (!row || !row.serverId) return reply.code(404).send({ error: 'действие не найдено' });
    if (row.finishedAt) return { cancelled: false, reason: 'уже завершено' };
    if (!registry.isOnline(row.serverId))
      return reply.code(409).send({ error: 'сервер не в сети' });
    return registry.request(row.serverId, 'command.cancel', { runId: aid }, { timeoutMs: 15_000 });
  });

  /** История запусков команды по всем серверам (для карточек каталога). */
  app.get('/api/commands/runs', async () => {
    return db
      .select({
        id: actionLog.id,
        serverId: actionLog.serverId,
        kind: actionLog.kind,
        startedAt: actionLog.startedAt,
        finishedAt: actionLog.finishedAt,
        exitCode: actionLog.exitCode,
      })
      .from(actionLog)
      .where(like(actionLog.kind, 'command:%'))
      .orderBy(desc(actionLog.startedAt))
      .limit(100);
  });

  // ---- файлы для скриптов: deploy.sh и бинарник WDTT и т.п. Без авторизации, как бинарники агента.
  app.get('/files/sha256/*', { config: downloadRateLimit }, async (req, reply) => {
    const f = safeFile((req.params as { '*': string })['*']);
    if (!f) return reply.code(404).send({ error: 'файл не найден' });
    return { sha256: await fileSha256(f) };
  });
  app.get('/files/*', { config: downloadRateLimit }, async (req, reply) => {
    const f = safeFile((req.params as { '*': string })['*']);
    if (!f) return reply.code(404).send({ error: 'файл не найден' });
    return sendFile(req, reply, f);
  });

  function safeFile(rel: string): string | null {
    const clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    if (clean.includes('..') || clean.startsWith('/')) return null;
    const f = join(env.FILES_DIR, clean);
    return existsSync(f) && statSync(f).isFile() ? f : null;
  }
}
