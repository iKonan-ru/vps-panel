import { DEVICE_IDS } from '@vps/protocol';
import { and, eq, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOnline } from '../agents/registry.js';
import { patchStatusCache } from '../agents/state.js';
import { awgClients, servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { awgClientConfigs, awgSaveKey } from '../lib/awg-clients.js';
import { awgKeyPair } from '../lib/awg-keys.js';
import { generateAwgParams, validateAwgParams } from '../lib/awg-params.js';
import { WgKey } from '../lib/validate.js';

const Id = z.object({ id: z.string() });

/** AmneziaWG: контейнеры amnezia-awg*, версии, клиенты. */
export async function awgRoutes(app: FastifyInstance, opts: ServerRouteOpts) {
  const { db, registry, hub, box } = opts;
  const journal = actionJournal(db, hub, registry);
  const { quickAction } = actionRunners(registry, journal);

  app.get('/api/servers/:id/awg', async (req) => {
    const { id } = Id.parse(req.params);
    requireOnline(registry, id);
    // ошибки агента (устарел - 409, сбой - 502) отдаёт общий обработчик с их текстом
    const st: {
      docker?: boolean;
      instances?: {
        container: string;
        version?: string;
        state?: string;
        params?: { key: string; value: string }[];
        clients?: { publicKey: string; managed?: boolean }[];
      }[];
    } = await registry.request(id, 'awg.status', {}, { timeoutMs: 60_000 });
    // версии экземпляров - для матрицы сервисов (lib/standard.ts)
    await patchStatusCache(db, id, {
      awgInstances: (st.instances ?? []).map((i) => ({
        container: i.container,
        version: i.version ?? '',
        state: i.state ?? '',
      })),
    });
    // ключ защиты заголовков - общий секрет всех клиентов экземпляра: в браузер не отдаём
    for (const inst of st.instances ?? [])
      for (const p of inst.params ?? []) if (p.key === 'HeaderProtectionKey') p.value = '***';
    // ключи клиентов контейнеров, которых на сервере больше нет (удалены командой): не нужны.
    // Только если агент точно получил список (docker ответил): иначе пустой список - сбой, а
    // ключи не восстановить. Остановленные контейнеры агент тоже перечисляет - их не трогаем.
    const present = (st.instances ?? []).map((i) => i.container);
    if (st.docker)
      db.delete(awgClients)
        .where(
          present.length
            ? and(eq(awgClients.serverId, id), notInArray(awgClients.container, present))
            : eq(awgClients.serverId, id),
        )
        .run();
    // клиенты, чей приватный ключ у панели: для них можно выдать конфиг
    const managed = new Set(
      (await db.select().from(awgClients).where(eq(awgClients.serverId, id))).map(
        (r) => `${r.container}/${r.publicKey}`,
      ),
    );
    for (const inst of st.instances ?? [])
      for (const c of inst.clients ?? [])
        c.managed = managed.has(`${inst.container}/${c.publicKey}`);
    return st;
  });

  /**
   * Конфиги клиента AWG во всех форматах. Приватный ключ - из базы панели; у клиентов
   * приложения Amnezia его нет нигде. Не действие:
   * ничего не меняет, секреты в журнал не пишутся; ответ не кэшируется.
   */
  app.post('/api/servers/:id/awg/config', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        container: z.string().regex(/^amnezia-awg[0-9]*(-[0-9]{1,5})?$/),
        publicKey: WgKey,
        mtu: z.coerce.number().int().min(1280).max(1420).default(1280),
      })
      .parse(req.body ?? {});
    const row = (await db.select().from(servers).where(eq(servers.id, id)).limit(1))[0];
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    requireOnline(registry, id);
    const cfg = await awgClientConfigs({
      db,
      registry,
      box,
      server: row,
      container: body.container,
      publicKey: body.publicKey,
      mtu: body.mtu,
    });
    reply.header('Cache-Control', 'no-store');
    return cfg;
  });

  /**
   * Операции над клиентом AWG. Новому клиенту панель сама делает ключи: на сервер уходит
   * только публичный, приватный хранится зашифрованным в базе и в журнал не попадает.
   */
  app.post('/api/servers/:id/awg/exec', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        op: z.enum([
          'client.add',
          'client.remove',
          'client.disable',
          'client.enable',
          'client.rename',
          'instance.setparams',
        ]),
        container: z.string().regex(/^amnezia-awg[0-9]*(-[0-9]{1,5})?$/),
        publicKey: WgKey.optional(),
        name: z.string().trim().max(64).optional(),
        /** Устройство клиента; пустая строка - не указано (client.add, client.rename). */
        device: z.enum(DEVICE_IDS).or(z.literal('')).optional(),
        /** instance.setparams: версия, под которую панель генерирует параметры заново. */
        profile: z.enum(['3.1', '2.0', '1.0']).optional(),
      })
      .parse(req.body ?? {});
    if (body.op === 'instance.setparams') {
      const profile = body.profile ?? '3.1';
      // легаси-контейнер amnezia-awg (образ amnezia-wg) умеет только 1.0
      if (body.container === 'amnezia-awg' && profile !== '1.0')
        throw Object.assign(new Error('старый контейнер amnezia-awg поддерживает только AWG 1.0'), {
          statusCode: 400,
        });
      const params = generateAwgParams(profile);
      const errors = validateAwgParams(params);
      if (errors.length) throw new Error(`параметры не прошли проверку: ${errors.join('; ')}`);
      const args = Object.fromEntries(Object.entries(params).map(([k, v]) => [`p.${k}`, v]));
      // в журнал - только версия: HeaderProtectionKey общий секрет клиентов экземпляра
      return quickAction<{ ok: boolean; version: string }>(
        id,
        'awg:instance.setparams',
        'awg.exec',
        { op: body.op, container: body.container, args },
        120_000,
        false,
        { op: body.op, container: body.container, profile },
      );
    }
    let keys: { privateKey: string; publicKey: string } | null = null;
    if (body.op === 'client.add') keys = awgKeyPair();
    const publicKey = keys?.publicKey ?? body.publicKey ?? '';
    const args: Record<string, string> = { publicKey };
    if (body.name) args.name = body.name;
    if (body.device !== undefined) args.device = body.device;
    const res = await quickAction<{ ok: boolean; ip?: string }>(
      id,
      `awg:${body.op}`,
      'awg.exec',
      { op: body.op, container: body.container, args },
      60_000,
    );
    if (keys) await awgSaveKey(db, box, id, body.container, publicKey, keys.privateKey);
    if (body.op === 'client.remove')
      await db
        .delete(awgClients)
        .where(
          and(
            eq(awgClients.serverId, id),
            eq(awgClients.container, body.container),
            eq(awgClients.publicKey, publicKey),
          ),
        );
    return { ...res, publicKey };
  });
}
