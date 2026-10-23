import {
  type GService,
  G_SERVICES,
  WATCH_DELAY_LIMITS,
  WATCH_MAX,
  WATCH_SERVICES,
  type WatchClientOption,
  type WatchList,
  type WatchRuleView,
  type WatchStatus,
  deviceLabel,
} from '@vps/protocol';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { clientWatches, gclientBindings, gclientDevices, gclients, servers } from '../db/schema.js';
import type { ClientWatch } from '../lib/client-watch.js';
import { newId } from '../lib/ids.js';

const Body = z.object({
  clientId: z.string().min(1).max(64),
  serverId: z.string().min(1).max(64).nullable(),
  service: z
    .enum(G_SERVICES as [GService, ...GService[]])
    .refine((s) => WATCH_SERVICES.includes(s), 'подключение к этому сервису не видно')
    .nullable(),
  deviceId: z.string().min(1).max(64).nullable(),
  event: z.enum(['down', 'up', 'both']),
  delayMinutes: z.number().int().min(WATCH_DELAY_LIMITS[0]).max(WATCH_DELAY_LIMITS[1]),
  enabled: z.boolean().default(true),
});
type Body = z.infer<typeof Body>;

const bad = (msg: string, code = 400) => Object.assign(new Error(msg), { statusCode: code });

/** Правила уведомлений о подключении клиентов: список с состоянием, создание, правка, удаление. */
export async function watchRoutes(
  app: FastifyInstance,
  opts: { db: Db; watch: Pick<ClientWatch, 'tick'> },
) {
  const { db, watch } = opts;

  /** Клиент, сервер и устройство существуют, устройство - этого клиента. */
  function check(b: Body) {
    const c = db.select().from(gclients).where(eq(gclients.id, b.clientId)).get();
    if (!c || c.deletedAt) throw bad('клиент не найден');
    if (b.serverId && !db.select().from(servers).where(eq(servers.id, b.serverId)).get())
      throw bad('сервер не найден');
    if (b.deviceId) {
      const d = db.select().from(gclientDevices).where(eq(gclientDevices.id, b.deviceId)).get();
      if (!d || d.deletedAt || d.clientId !== b.clientId) throw bad('устройство не найдено');
    }
  }

  app.get('/api/watch', async (_req, reply): Promise<WatchList> => {
    const rules = db.select().from(clientWatches).all();
    const clients = db.select().from(gclients).where(isNull(gclients.deletedAt)).all();
    const serverRows = db.select({ id: servers.id, name: servers.name }).from(servers).all();
    const serverName = new Map(serverRows.map((s) => [s.id, s.name]));
    const devices = db.select().from(gclientDevices).all();
    const deviceName = new Map(devices.map((d) => [d.id, deviceLabel(d)]));
    const clientName = new Map(clients.map((c) => [c.id, c.name]));
    const bindings = db.select().from(gclientBindings).all();
    reply.header('Cache-Control', 'no-store');
    const views: WatchRuleView[] = rules
      .filter((r) => clientName.has(r.clientId))
      .map((r) => {
        const st = r.state;
        const status: WatchStatus = !r.enabled
          ? 'off'
          : !st
            ? 'pending'
            : !st.primed
              ? 'unknown'
              : st.status;
        return {
          id: r.id,
          clientId: r.clientId,
          serverId: r.serverId,
          service: r.service as GService | null,
          deviceId: r.deviceId,
          event: r.event,
          delayMinutes: r.delayMinutes,
          enabled: r.enabled,
          clientName: clientName.get(r.clientId) ?? '',
          serverName: r.serverId ? (serverName.get(r.serverId) ?? '') : null,
          deviceName: r.deviceId ? (deviceName.get(r.deviceId) ?? '') : null,
          status,
          offline: r.enabled && Boolean(st?.offline),
          lastSeen: st?.lastSeen ?? null,
          downSince: st?.downSince ?? null,
          checkedAt: st?.checkedAt ?? null,
          note: st?.note ?? '',
        };
      })
      .sort(
        (a, b) =>
          a.clientName.localeCompare(b.clientName, 'ru') ||
          (a.serverName ?? '').localeCompare(b.serverName ?? '', 'ru'),
      );
    const options: WatchClientOption[] = clients
      .map((c) => ({
        id: c.id,
        name: c.name,
        devices: devices
          .filter((d) => d.clientId === c.id && !d.deletedAt)
          .map((d) => ({ id: d.id, name: deviceLabel(d) })),
        targets: bindings
          .filter((b) => b.clientId === c.id && WATCH_SERVICES.includes(b.service as GService))
          .map((b) => ({
            serverId: b.serverId,
            serverName: serverName.get(b.serverId) ?? b.serverId,
            service: b.service as GService,
            deviceId: b.deviceId,
          })),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
    return { rules: views, clients: options };
  });

  app.post('/api/watch', async (req) => {
    const b = Body.parse(req.body ?? {});
    check(b);
    if (db.select({ id: clientWatches.id }).from(clientWatches).all().length >= WATCH_MAX)
      throw bad(`правил не больше ${WATCH_MAX}`);
    const id = newId();
    db.insert(clientWatches)
      .values({ id, ...b })
      .run();
    void watch.tick();
    return { id };
  });

  app.put('/api/watch/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    const b = Body.parse(req.body ?? {});
    const old = db.select().from(clientWatches).where(eq(clientWatches.id, id)).get();
    if (!old) throw bad('правило не найдено', 404);
    check(b);
    // изменилось, за чем или как следим, - наблюдение заново (первая проверка - без сообщений);
    // только событие - наблюдение остаётся
    const same =
      old.clientId === b.clientId &&
      old.serverId === b.serverId &&
      old.service === b.service &&
      old.deviceId === b.deviceId &&
      old.delayMinutes === b.delayMinutes &&
      old.enabled === b.enabled;
    db.update(clientWatches)
      .set({ ...b, ...(same ? {} : { state: null }) })
      .where(eq(clientWatches.id, id))
      .run();
    if (!same) void watch.tick();
    return { ok: true };
  });

  app.delete('/api/watch/:id', async (req) => {
    const { id } = z.object({ id: z.string() }).parse(req.params);
    db.delete(clientWatches).where(eq(clientWatches.id, id)).run();
    return { ok: true };
  });
}
