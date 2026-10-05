import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { installCommand, issueRegistration } from '../lib/agent-dist.js';
import { loadPanelKey, sshRun } from '../lib/ssh.js';
import type { UiHub } from '../lib/ui-hub.js';

const AuthSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('password'), password: z.string().min(1).max(200) }),
  z.object({ mode: z.literal('key') }),
]);

/**
 * Установка агента по SSH. Пароль root используется один раз и нигде не
 * сохраняется; ключ панели - альтернатива для серверов, где он добавлен в
 * authorized_keys. Вывод установщика стримится как обычное действие.
 */
export async function installRoutes(
  app: FastifyInstance,
  opts: { db: Db; env: Env; registry: AgentRegistry; hub: UiHub },
) {
  const { db, env, registry, hub } = opts;
  const journal = actionJournal(db, hub, registry);

  app.get('/api/panel/ssh-key', async () => ({ publicKey: loadPanelKey(env.DATA_DIR).publicKey }));

  app.post('/api/servers/:id/install', async (req, reply) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const auth = AuthSchema.parse(req.body);
    const row = (await db.select().from(servers).where(eq(servers.id, id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: 'Сервер не найден' });

    // Новый одноразовый токен регистрации на каждую установку.
    const registrationToken = (await issueRegistration(db, id)) ?? '';

    // без проверки занятости: переустановкой чинят и зависшего агента
    const action = journal.open(id, 'agent.install', { mode: auth.mode }, true);
    const out = (chunk: string) => action.stream('log', chunk);
    const finish = async (exitCode: number) => {
      await action.finish(exitCode);
      hub.broadcast({ type: 'server.changed', serverId: id });
    };

    void (async () => {
      try {
        out(
          `Подключаюсь к root@${row.host}:${row.sshPort} (${auth.mode === 'password' ? 'пароль' : 'ключ панели'})...\n`,
        );
        const target = {
          host: row.host,
          port: row.sshPort,
          knownFingerprint: row.hostKeyFingerprint,
          auth:
            auth.mode === 'password'
              ? auth
              : { mode: 'key' as const, privateKey: loadPanelKey(env.DATA_DIR).privateKey },
        };
        const res = await sshRun(target, installCommand(env, registrationToken), out);
        if (!row.hostKeyFingerprint && res.fingerprint) {
          await db
            .update(servers)
            .set({ hostKeyFingerprint: res.fingerprint })
            .where(eq(servers.id, id));
          out(`Отпечаток ключа хоста запомнен: ${res.fingerprint}\n`);
        }
        if (res.exitCode !== 0) {
          out(`\nУстановщик завершился с кодом ${res.exitCode}\n`);
          return finish(res.exitCode);
        }
        out('Жду, пока агент подключится к панели...\n');
        const okOnline = await waitOnline(registry, id, 60_000);
        out(
          okOnline
            ? 'Агент на связи.\n'
            : 'Агент не подключился за минуту. Проверь, доступен ли адрес панели с этого сервера.\n',
        );
        await finish(okOnline ? 0 : 2);
      } catch (e) {
        out(`\nОШИБКА: ${e instanceof Error ? e.message : String(e)}\n`);
        await finish(1);
      }
    })();

    return { actionId: action.id };
  });

  /** Сброс отпечатка хоста: после переустановки ОС ключ сервера меняется. */
  app.delete('/api/servers/:id/host-key', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    await db.update(servers).set({ hostKeyFingerprint: '' }).where(eq(servers.id, id));
    return { ok: true };
  });
}

function waitOnline(
  registry: AgentRegistry,
  serverId: string,
  timeoutMs: number,
): Promise<boolean> {
  if (registry.isOnline(serverId)) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onOnline = (id: string) => {
      if (id !== serverId) return;
      cleanup();
      resolve(true);
    };
    const t = setTimeout(() => {
      cleanup();
      resolve(false);
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(t);
      registry.off('online', onOnline);
    };
    registry.on('online', onOnline);
  });
}
