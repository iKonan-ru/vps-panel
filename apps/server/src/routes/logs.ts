import { Readable } from 'node:stream';
import { createGzip } from 'node:zlib';
import {
  LOG_CATEGORIES,
  LOG_CATEGORY_TITLES,
  LOG_DAYS_MAX,
  LOG_FEED_CATEGORIES,
  LOG_MB_MAX,
  LOG_MB_MIN,
  type LogAccessState,
  type LogDestRow,
  type LogFeed,
  type LogFilter,
  type LogsView,
} from '@vps/protocol';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { sha256 } from '../lib/auth.js';
import type { Cascades } from '../lib/cascades.js';
import { saveLogSettings } from '../lib/server-log-bind.js';
import { type FeedFilter, type ServerLog, formatRows } from '../lib/server-log.js';
import { type StepUp, hasStepUp } from '../lib/step-up.js';
import { sessionToken } from './auth.js';

const days = z.number().int().min(1).max(LOG_DAYS_MAX);

const SettingsBody = z.object({
  enabled: z.boolean(),
  days: z.object(
    Object.fromEntries(LOG_CATEGORIES.map((c) => [c, days])) as Record<
      (typeof LOG_CATEGORIES)[number],
      typeof days
    >,
  ),
  maxMb: z.number().int().min(LOG_MB_MIN).max(LOG_MB_MAX),
});

const isoDate = z
  .string()
  .refine((s) => Number.isFinite(Date.parse(s)), 'неверная дата')
  .optional();

const FilterSchema = z.object({
  servers: z.array(z.string().max(64)).max(500).optional(),
  categories: z.array(z.enum(LOG_CATEGORIES)).optional(),
  from: isoDate,
  to: isoDate,
  clientId: z.string().max(64).optional(),
  ip: z.string().max(64).optional(),
});

/** Фильтр из строки запроса выгрузки: списки - через запятую. */
function queryFilter(q: Record<string, string | undefined>): LogFilter {
  const list = (v?: string) => (v ? v.split(',').filter(Boolean) : undefined);
  const raw = {
    servers: list(q.servers),
    categories: list(q.categories),
    from: q.from || undefined,
    to: q.to || undefined,
    clientId: q.clientId || undefined,
    ip: q.ip || undefined,
  };
  return FilterSchema.parse(
    Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)),
  ) as LogFilter;
}

const FeedQuery = z.object({
  servers: z.string().max(4000).optional(),
  categories: z.string().max(200).optional(),
  level: z.enum(['warn', 'error']).optional(),
  from: isoDate,
  to: isoDate,
  q: z.string().max(200).optional(),
  cursor: z
    .string()
    .regex(/^\d+:[01]:\d+$/)
    .optional(),
});

/** Фильтр ленты из строки запроса. */
function feedFilter(raw: unknown): { f: FeedFilter; cursor?: string } {
  const q = FeedQuery.parse(raw ?? {});
  const list = (v?: string) => (v ? v.split(',').filter(Boolean) : undefined);
  const cats = list(q.categories)?.filter((c) =>
    (LOG_FEED_CATEGORIES as readonly string[]).includes(c),
  );
  const servers = list(q.servers);
  const f: FeedFilter = {
    ...(servers?.length ? { servers } : {}),
    ...(cats?.length ? { categories: cats } : {}),
    ...(q.level ? { level: q.level } : {}),
    ...(q.from ? { from: q.from } : {}),
    ...(q.to ? { to: q.to } : {}),
    ...(q.q?.trim() ? { q: q.q.trim() } : {}),
  };
  return { f, ...(q.cursor ? { cursor: q.cursor } : {}) };
}

/** Фильтр словами: для записи об операции с журналом. */
function filterText(f: LogFilter): string {
  const parts: string[] = [];
  if (f.categories?.length)
    parts.push(`разделы: ${f.categories.map((c) => LOG_CATEGORY_TITLES[c]).join(', ')}`);
  if (f.servers?.length) parts.push(`серверов: ${f.servers.length}`);
  if (f.from) parts.push(`с ${f.from}`);
  if (f.to) parts.push(`по ${f.to}`);
  if (f.clientId) parts.push('клиент');
  if (f.ip) parts.push(`адрес ${f.ip}`);
  return parts.length ? parts.join('; ') : 'всё';
}

/** Журнал серверов: настройки, размер, выгрузка и удаление записей. */
export async function logRoutes(
  app: FastifyInstance,
  opts: {
    db: Db;
    slog: ServerLog;
    access: () => LogAccessState[];
    cascades: Pick<Cascades, 'setAccessLog'>;
    stepUp: StepUp;
    secure: boolean;
  },
) {
  const { db, slog, access, cascades, stepUp, secure } = opts;
  // выгрузка (адреса клиентов) и удаление - после подтверждения пароля и 2FA
  const guard = (req: FastifyRequest, reply: FastifyReply) => {
    const sid = sessionToken(req);
    if (!sid || !hasStepUp(stepUp, req, secure, sha256(sid)))
      return reply
        .code(403)
        .send({ error: 'нужно подтверждение пароля и 2FA', code: 'step_up_required' });
    return null;
  };

  const view = (): LogsView => ({
    settings: slog.settings,
    stats: slog.stats(),
    access: access(),
  });

  app.get('/api/logs', async () => view());

  /** Лента: события и сеансы подключений, новые первыми, по 100. */
  app.get('/api/logs/feed', async (req): Promise<LogFeed> => {
    const { f, cursor } = feedFilter(req.query);
    return slog.feed(f, 100, cursor);
  });

  /** Назначения за период по клиенту и адресу (поиск - клиент, пользователь xray, адрес). */
  app.get(
    '/api/logs/dest',
    async (req): Promise<LogDestRow[]> => slog.destTop(feedFilter(req.query).f),
  );

  app.put('/api/logs/settings', async (req) => {
    const s = SettingsBody.parse(req.body ?? {});
    saveLogSettings(db, s);
    slog.configure(s);
    // новые сроки и предел - сразу, а не через час
    slog.prune();
    return view();
  });

  /** Выгрузка файлом .gz: JSON по строке (jsonl) или CSV. */
  app.get('/api/logs/export', async (req, reply) => {
    if (guard(req, reply)) return;
    const q = req.query as Record<string, string | undefined>;
    const format = q.format === 'csv' ? 'csv' : 'jsonl';
    const f = queryFilter(q);
    slog.event({
      serverId: null,
      category: 'logs',
      level: 'info',
      type: 'export',
      text: `Выгрузка журнала (${format}): ${filterText(f)}`,
      data: f,
    });
    const ts = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    const stream = Readable.from(formatRows(slog.rows(f), format)).pipe(createGzip());
    return reply
      .header('Content-Type', 'application/gzip')
      .header('Content-Disposition', `attachment; filename="server-log-${ts}.${format}.gz"`)
      .header('Cache-Control', 'no-store')
      .send(stream);
  });

  /**
   * Журнал доступа xray на сервере (назначения клиентов): запись в шаблон Xray 3X-UI -
   * действием сервера, Xray перезапускается.
   */
  app.post('/api/logs/access/:id', async (req) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    return { actionId: cascades.setAccessLog((req.params as { id: string }).id, enabled) };
  });

  /** Удаление по фильтру; без фильтра - весь журнал. */
  app.post('/api/logs/delete', async (req, reply) => {
    if (guard(req, reply)) return;
    const f = FilterSchema.parse(req.body ?? {}) as LogFilter;
    const deleted = slog.delete(f);
    slog.event({
      serverId: null,
      category: 'logs',
      level: 'warn',
      type: 'delete',
      text: `Удалено записей журнала: ${deleted} (${filterText(f)})`,
      data: { ...f, deleted },
    });
    return { deleted, ...view() };
  });
}
