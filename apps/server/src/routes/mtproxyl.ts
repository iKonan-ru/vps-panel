import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { MT_SECRET_OUTPUT_OPS } from '../lib/mtproxyl-secrets.js';
import { MtproxylArgs } from '../lib/validate.js';

const Id = z.object({ id: z.string() });

/** MTProxyL: экраны поверх CLI mtproxyl, версии движка telemt. */
export async function mtproxylRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, registry, hub, engines } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);

  app.get('/api/servers/:id/mtproxyl', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    return registry.request(id, 'mtproxyl.status', {}, { timeoutMs: 120_000 });
  });
  /** Версии движка telemt: установленная и те, что ставятся без сборки на сервере. */
  app.get('/api/servers/:id/mtproxyl/engine', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    return engines.info(id);
  });
  /** Операции, которые печатают ссылки с секретом пользователя: их вывод в журнал не пишется. */
  const mtSecretOutputOps = new Set(MT_SECRET_OUTPUT_OPS);
  /** Длинные операции идут действием со стримом, короткие возвращают вывод сразу. */
  const mtLongOps = new Set([
    'update',
    'restart',
    'panel.update',
    'panel.restart',
    'engine.update',
  ]);
  app.post('/api/servers/:id/mtproxyl/exec', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        op: z.string().regex(/^[a-z0-9.-]{1,40}$/),
        args: MtproxylArgs.default({}),
      })
      .parse(req.body ?? {});
    // без готового образа MTProxyL собрал бы движок из исходников - слабый сервер может повиснуть
    if (body.op === 'engine.update') {
      const info = await engines.info(id);
      const v = info.versions.find((x) => x.tag === body.args.version);
      if (!v?.ready)
        throw Object.assign(
          new Error(
            info.registryError
              ? `Реестр образов не ответил (${info.registryError}): неизвестно, будет ли сборка на сервере`
              : `Для версии ${body.args.version ?? '?'} нет готового образа: MTProxyL собирал бы движок на сервере`,
          ),
          { statusCode: 409 },
        );
    }
    if (mtLongOps.has(body.op)) {
      const actionId = await runStreamed(
        id,
        `mtproxyl:${body.op}`,
        'mtproxyl.exec',
        body,
        15 * 60_000,
      );
      return { actionId };
    }
    const { secret, ...logArgs } = body.args;
    return quickAction<{ ok: boolean; output: string }>(
      id,
      `mtproxyl:${body.op}`,
      'mtproxyl.exec',
      body,
      120_000,
      mtSecretOutputOps.has(body.op),
      secret ? { ...body, args: { ...logArgs, secret: '***' } } : body,
    );
  });
}
