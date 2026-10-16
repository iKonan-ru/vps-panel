import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOnline } from '../agents/registry.js';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { busyAction } from '../lib/action-lock.js';
import type { ServerRouteOpts } from '../lib/action-runners.js';
import { agentChecksums, latestAgentVersion } from '../lib/agent-dist.js';

const Id = z.object({ id: z.string() });

/** Обновление агента: на одном сервере (с ожиданием возвращения) и раскатка по всем по очереди. */
export async function agentUpdateRoutes(
  app: FastifyInstance,
  opts: ServerRouteOpts & {
    /** После старта: раскатить устаревших агентов (панель обновилась и это включено). */
    autoRollout?: () => boolean;
  },
) {
  const { db, env, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);

  /** Отмена идущего обновления агента (загрузка на узком канале). */
  app.post('/api/servers/:id/agent/update/cancel', async (req) => {
    const { id } = Id.parse(req.params);
    return registry.request(id, 'agent.update.cancel', {}, { timeoutMs: 15_000 });
  });

  /** Ждёт, пока агент отвалится и вернётся (перезапуск). true - вернулся в срок. */
  function waitAgentReturn(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let sawOffline = !registry.isOnline(id);
      const t = setTimeout(() => done(false), timeoutMs);
      const onOffline = (sid: string) => {
        if (sid === id) sawOffline = true;
      };
      const onOnline = (sid: string) => {
        if (sid === id && sawOffline) done(true);
      };
      const done = (v: boolean) => {
        clearTimeout(t);
        registry.off('offline', onOffline);
        registry.off('online', onOnline);
        resolve(v);
      };
      registry.on('offline', onOffline);
      registry.on('online', onOnline);
    });
  }

  /**
   * Самообновление агента - одно действие на весь путь: запрос, загрузка (агент пишет
   * ход, на узком канале это десятки минут), перезапуск и возвращение агента на связь.
   * Панель дописывает свои строки, чтобы вывод был понятен и со старым агентом без стрима.
   */
  async function startAgentUpdate(
    id: string,
  ): Promise<{ actionId: string; done: Promise<number> }> {
    const row = (await db.select().from(servers).where(eq(servers.id, id)).limit(1))[0];
    requireOnline(registry, id);
    const action = journal.open(id, 'agent.update');
    const actionId = action.id;
    const onStream = action.stream;
    const say = (line: string) => onStream('log', `${line}\n`);
    const finish = async (code: number) => {
      await action.finish(code);
      return code;
    };
    const latest = latestAgentVersion(env.AGENT_DIR) ?? '?';
    say(`Панель: обновление агента ${row?.agentVersion ?? '?'} -> ${latest}`);

    const done = (async (): Promise<number> => {
      try {
        // агенты 0.1.x без самообновления (переустановка через exec.run) остались в прошлом
        const r = await registry.request<{ restarting?: boolean; message?: string }>(
          id,
          'agent.update',
          // контрольные суммы - по защищённому каналу: агент сверяет с ними скачанный бинарник
          { sha256: await agentChecksums(env.AGENT_DIR) },
          { timeoutMs: 50 * 60_000, onStream },
        );
        if (!r?.restarting) {
          say(`Агент: ${r?.message ?? 'обновление не требуется'}`);
          return finish(0);
        }
        say('Агент: бинарник заменён, перезапускаюсь');
        registry.markUpdating(id);
        hub.broadcast({ type: 'server.changed', serverId: id });
        say('Панель: жду, пока агент вернётся на связь...');
        const back = await waitAgentReturn(id, 3 * 60_000);
        if (!back) {
          say(
            'ОШИБКА: агент не вернулся за 3 минуты. Журнал на сервере: journalctl -u vps-agent -n 20',
          );
          return finish(1);
        }
        const after = (await db.select().from(servers).where(eq(servers.id, id)).limit(1))[0];
        say(`Панель: агент снова на связи, версия ${after?.agentVersion ?? '?'}`);
        return finish(0);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        say(msg.includes('context canceled') ? 'Обновление отменено' : `ОШИБКА: ${msg}`);
        return finish(1);
      }
    })();
    return { actionId, done };
  }
  app.post('/api/servers/:id/agent/update', async (req) => {
    const { id } = Id.parse(req.params);
    const { actionId } = await startAgentUpdate(id);
    return { actionId };
  });

  /**
   * Раскатка агентов на все серверы с устаревшей версией: строго по очереди, каждый раз
   * до возвращения агента с новой версией. Первая ошибка останавливает раскатку - плохая
   * сборка агента не уронит все серверы разом. Не в сети и занятые другим действием -
   * пропускаются. Одна раскатка за раз, состояние - в памяти и событием agents.rollout.
   */
  type RolloutItem = {
    serverId: string;
    name: string;
    status: 'pending' | 'running' | 'ok' | 'skipped' | 'error';
    note: string;
    actionId?: string;
  };
  let rollout: { startedAt: string; finishedAt: string | null; items: RolloutItem[] } | null = null;
  const rolloutChanged = () => hub.broadcast({ type: 'agents.rollout' });

  app.get('/api/agents/rollout', async () => rollout);
  app.post('/api/agents/rollout', async (_req, reply) => {
    const r = await startRollout();
    if (typeof r === 'string')
      return reply.code(r === 'busy' ? 409 : 400).send({ error: errors[r] });
    return r;
  });
  const errors = { busy: 'обновление агентов уже идёт', fresh: 'все агенты уже последней версии' };

  // панель обновилась (релиз) и включено "обновлять агентов": через 90 с - агенты успевают
  // переподключиться к новой панели
  if (opts.autoRollout?.())
    setTimeout(() => {
      void startRollout().then((r) => {
        if (typeof r !== 'string')
          app.log.info({ servers: r.items.length }, 'agents: автораскатка');
      });
    }, 90_000).unref();

  async function startRollout(): Promise<NonNullable<typeof rollout> | 'busy' | 'fresh'> {
    if (rollout && !rollout.finishedAt) return 'busy';
    const latest = latestAgentVersion(env.AGENT_DIR);
    const rows = (await db.select().from(servers).orderBy(servers.name)).filter(
      (r) => latest && r.agentVersion && r.agentVersion !== latest,
    );
    if (rows.length === 0) return 'fresh';
    const cur = {
      startedAt: new Date().toISOString(),
      finishedAt: null as string | null,
      items: rows.map(
        (r): RolloutItem => ({
          serverId: r.id,
          name: r.name,
          status: 'pending',
          note: '',
        }),
      ),
    };
    rollout = cur;
    rolloutChanged();
    void (async () => {
      for (const [i, it] of cur.items.entries()) {
        if (!registry.isOnline(it.serverId)) {
          Object.assign(it, { status: 'skipped', note: 'не в сети' });
        } else if (busyAction(db, it.serverId)) {
          Object.assign(it, { status: 'skipped', note: 'на сервере идёт другое действие' });
        } else {
          it.status = 'running';
          rolloutChanged();
          try {
            const { actionId, done } = await startAgentUpdate(it.serverId);
            it.actionId = actionId;
            rolloutChanged();
            const code = await done;
            Object.assign(
              it,
              code === 0 ? { status: 'ok' } : { status: 'error', note: 'см. журнал' },
            );
          } catch (e) {
            Object.assign(it, { status: 'error', note: (e as Error).message });
          }
        }
        rolloutChanged();
        if (it.status === 'error') {
          for (const rest of cur.items.slice(i + 1))
            Object.assign(rest, { status: 'skipped', note: 'обновление остановлено после ошибки' });
          break;
        }
      }
      cur.finishedAt = new Date().toISOString();
      rolloutChanged();
    })();
    return cur;
  }
}
