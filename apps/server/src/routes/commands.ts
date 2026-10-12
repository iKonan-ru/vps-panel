import { existsSync, statSync } from 'node:fs';
import { join, normalize } from 'node:path';
import { and, desc, eq, inArray, like } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import {
  CATALOG,
  defaultsFor,
  findCommand,
  stripSecrets,
  validateAnswers,
} from '../commands/index.js';
import { type RunContext, toInfo } from '../commands/types.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { access, actionLog, commandDefaults, gclientBindings, servers } from '../db/schema.js';
import { upsertAccess } from '../lib/access.js';
import { actionJournal } from '../lib/action-journal.js';
import { latestAgentVersion } from '../lib/agent-dist.js';
import { awgLiveDefaults } from '../lib/awg-alloc.js';
import { clientHost } from '../lib/client-host.js';
import { downloadRateLimit, fileSha256, sendFile } from '../lib/file-send.js';
import { queued } from '../lib/gclients.js';
import { slugify } from '../lib/panel-proxy.js';
import { redactOutput } from '../lib/redact.js';
import type { SecretBox } from '../lib/secret-box.js';
import type { UiHub } from '../lib/ui-hub.js';

const Answers = z.record(z.string(), z.string().max(4000));

/**
 * Команды каталога: список, значения по умолчанию, проверки перед запуском,
 * запуск со стримом, отмена, файлы для скриптов (/files/...).
 */
export async function commandRoutes(
  app: FastifyInstance,
  opts: { db: Db; env: Env; registry: AgentRegistry; hub: UiHub; box: SecretBox },
) {
  const { db, env, registry, hub, box } = opts;
  const journal = actionJournal(db, hub, registry);

  app.get('/api/commands', async () => CATALOG.map(toInfo));

  /** Имя прокси для браузера: <слаг сервера>.<домен панели>. */
  async function naiveLiveDefaults(id: string): Promise<Record<string, string>> {
    const row = (
      await db.select({ name: servers.name }).from(servers).where(eq(servers.id, id))
    )[0];
    if (!row) return {};
    return { NAIVE_DOMAIN: `${slugify(row.name)}.${new URL(env.PANEL_PUBLIC_URL).hostname}` };
  }

  /** Значения по умолчанию для формы: сохранённые ответы для сервера поверх default/generate. */
  app.get('/api/servers/:id/commands/:cmd/defaults', async (req, reply) => {
    const { id, cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    const c = findCommand(cmd);
    if (!c) return reply.code(404).send({ error: 'Команда не найдена' });
    const saved = (
      await db
        .select()
        .from(commandDefaults)
        .where(and(eq(commandDefaults.serverId, id), eq(commandDefaults.commandId, cmd)))
        .limit(1)
    )[0];
    const live =
      c.liveDefaults === 'awg'
        ? await awgLiveDefaults(db, registry, id)
        : c.liveDefaults === 'naive'
          ? await naiveLiveDefaults(id)
          : {};
    return { ...defaultsFor(c), ...(saved?.answers ?? {}), ...live };
  });

  /** План "что будет сделано" по текущим ответам. */
  app.post('/api/servers/:id/commands/:cmd/plan', async (req, reply) => {
    const { cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    const c = findCommand(cmd);
    if (!c) return reply.code(404).send({ error: 'Команда не найдена' });
    const answers = Answers.parse(req.body ?? {});
    return { steps: c.plan(answers), errors: validateAnswers(c, answers) };
  });

  /** Быстрые проверки на сервере: строки OK|, WARN|, FAIL|. */
  app.post('/api/servers/:id/commands/:cmd/preflight', async (req, reply) => {
    const { id, cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    const c = findCommand(cmd);
    if (!c) return reply.code(404).send({ error: 'Команда не найдена' });
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    const answers = Answers.parse(req.body ?? {});
    const errors = validateAnswers(c, answers);
    const checks: { level: 'ok' | 'warn' | 'fail'; text: string }[] = errors.map((e) => ({
      level: 'fail',
      text: e,
    }));
    const row = await serverRow(id);
    if (!row) return reply.code(404).send({ error: 'Сервер не найден' });
    checks.push(
      row.agentUpdateAvailable
        ? { level: 'warn', text: 'Агент устарел - обнови его перед запуском' }
        : { level: 'ok', text: 'Агент в сети' },
    );
    if (c.preflight) {
      const res = await registry.request<{ exitCode: number; tail: string }>(
        id,
        'command.run',
        {
          script: c.preflight,
          env: baseEnv(
            row,
            answers,
            c.env?.({ panelUrl: env.PANEL_PUBLIC_URL, server: row, answers }) ?? {},
            c.params,
          ),
          timeoutSec: 60,
        },
        { timeoutMs: 90_000 },
      );
      for (const line of res.tail.split('\n')) {
        const m = /^(OK|WARN|FAIL)\|(.*)$/.exec(line.trim());
        if (m)
          checks.push({ level: m[1]?.toLowerCase() as 'ok' | 'warn' | 'fail', text: m[2] ?? '' });
      }
      if (res.exitCode !== 0 && !checks.some((ch) => ch.level === 'fail'))
        checks.push({ level: 'warn', text: `скрипт проверок завершился с кодом ${res.exitCode}` });
    }
    return { checks, canRun: !checks.some((ch) => ch.level === 'fail') };
  });

  /** Запуск: действие command:<id> со стримом вывода. */
  app.post('/api/servers/:id/commands/:cmd/run', async (req, reply) => {
    const { id, cmd } = z.object({ id: z.string(), cmd: z.string() }).parse(req.params);
    const c = findCommand(cmd);
    if (!c) return reply.code(404).send({ error: 'Команда не найдена' });
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    const answers = Answers.parse(req.body ?? {});
    const errors = validateAnswers(c, answers);
    if (errors.length) return reply.code(400).send({ error: errors.join('; ') });
    const row = await serverRow(id);
    if (!row) return reply.code(404).send({ error: 'Сервер не найден' });

    const ctx: RunContext = { panelUrl: env.PANEL_PUBLIC_URL, server: row, answers };
    const extraEnv = c.env?.(ctx) ?? {};
    const files = c.files?.(ctx) ?? {};
    const publicAnswers = stripSecrets(c, answers);
    await db
      .insert(commandDefaults)
      .values({ serverId: id, commandId: cmd, answers: publicAnswers })
      .onConflictDoUpdate({
        target: [commandDefaults.serverId, commandDefaults.commandId],
        set: { answers: publicAnswers },
      });

    const action = journal.open(id, `command:${cmd}`, { title: c.title, answers: publicAnswers });
    const actionId = action.id;
    const onStream = action.stream;
    const finish = async (exitCode: number) => {
      // доступы к установленной панели: логин, пароль, ссылки - в "Доступы" сервера
      let entries: Parameters<typeof upsertAccess>[3][] = [];
      if (exitCode === 0 && c.access) {
        try {
          entries = [c.access({ ...ctx, output: action.output }) ?? []].flat();
        } catch (e) {
          app.log.warn({ err: (e as Error).message }, 'access: не удалось сохранить доступы');
        }
      }
      // секреты в журнал не пишутся: в "Доступах" они зашифрованы, а журнал - открытым текстом
      const secrets = [
        ...c.params.filter((p) => p.secret || p.type === 'password').map((p) => answers[p.name]),
        ...entries.flatMap((e) => e.fields.filter((f) => f.secret).map((f) => f.value)),
        // переменные-секреты, которые панель генерирует сама (токен admin API WDTT)
        ...Object.entries(extraEnv)
          .filter(([k]) => /(TOKEN|SECRET|PASSWORD)$/.test(k))
          .map(([, v]) => v),
      ].filter((v): v is string => Boolean(v));
      if (exitCode === 0 && c.resync?.length)
        db.update(gclientBindings)
          .set(queued())
          .where(and(eq(gclientBindings.serverId, id), inArray(gclientBindings.service, c.resync)))
          .run();
      if (exitCode === 0 && c.forgetsAccess?.length)
        db.delete(access)
          .where(and(eq(access.serverId, id), inArray(access.kind, c.forgetsAccess)))
          .run();
      for (const e of entries) {
        try {
          await upsertAccess(db, box, id, e);
        } catch (e) {
          app.log.warn({ err: (e as Error).message }, 'access: не удалось сохранить доступы');
        }
      }
      await action.finish(exitCode, redactOutput(action.output, secrets));
    };
    registry
      .request<{ exitCode: number; killed: boolean }>(
        id,
        'command.run',
        {
          runId: actionId,
          script: c.script,
          env: baseEnv(row, answers, extraEnv, c.params),
          files,
          cleanup: c.cleanup ?? [],
          timeoutSec: c.timeoutSec,
        },
        { timeoutMs: (c.timeoutSec + 60) * 1000, onStream },
      )
      .then((r) => finish(r.exitCode))
      .catch((e: Error) => {
        onStream('stderr', `\nОШИБКА: ${e.message}\n`);
        void finish(1);
      });
    return { actionId };
  });

  /** Остановить выполняющуюся команду. */
  app.post('/api/actions/:aid/cancel', async (req, reply) => {
    const { aid } = z.object({ aid: z.string() }).parse(req.params);
    const row = (await db.select().from(actionLog).where(eq(actionLog.id, aid)).limit(1))[0];
    if (!row || !row.serverId) return reply.code(404).send({ error: 'Действие не найдено' });
    if (row.finishedAt) return { cancelled: false, reason: 'уже завершено' };
    if (!registry.isOnline(row.serverId))
      return reply.code(409).send({ error: 'Агент не подключён' });
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
    if (!f) return reply.code(404).send({ error: 'нет файла' });
    return { sha256: await fileSha256(f) };
  });
  app.get('/files/*', { config: downloadRateLimit }, async (req, reply) => {
    const f = safeFile((req.params as { '*': string })['*']);
    if (!f) return reply.code(404).send({ error: 'нет файла' });
    return sendFile(req, reply, f);
  });

  function safeFile(rel: string): string | null {
    const clean = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '');
    if (clean.includes('..') || clean.startsWith('/')) return null;
    const f = join(env.FILES_DIR, clean);
    return existsSync(f) && statSync(f).isFile() ? f : null;
  }

  async function serverRow(id: string) {
    const r = (
      await db
        .select({
          id: servers.id,
          name: servers.name,
          host: servers.host,
          sshPort: servers.sshPort,
          agentVersion: servers.agentVersion,
        })
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1)
    )[0];
    if (!r) return null;
    const latest = latestAgentVersion(env.AGENT_DIR);
    return {
      ...r,
      agentUpdateAvailable: Boolean(latest && r.agentVersion && r.agentVersion !== latest),
    };
  }
  function baseEnv(
    row: { host: string; name: string; sshPort: number; clientHost?: string | null },
    answers: Record<string, string>,
    extra: Record<string, string>,
    params: { name: string; type: string }[] = [],
  ) {
    // Только объявленные параметры (лишний ключ из запроса мог бы задать PATH или BASH_ENV) и
    // такими, какими их проверил validateAnswers - без пробелов по краям; пароли - как есть.
    // Скрипты идут под set -u: каждый объявленный параметр есть в окружении, хотя бы пустым.
    const declared: Record<string, string> = {};
    for (const p of params) {
      const v = answers[p.name] ?? '';
      declared[p.name] = p.type === 'password' ? v : v.trim();
    }
    return {
      ...declared,
      ...extra,
      PANEL_URL: env.PANEL_PUBLIC_URL,
      SERVER_HOST: row.host,
      // адрес сервера в конфигах людей (имя из "Адреса для клиентов" или IP)
      CLIENT_HOST: clientHost(row),
      SERVER_NAME: row.name,
      SERVER_SSH_PORT: String(row.sshPort),
    };
  }
}
