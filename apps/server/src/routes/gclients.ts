import {
  DEVICE_IDS,
  type GBinding,
  type GBindingLinks,
  type GBindingState,
  type GClientAccess,
  type GClientDetail,
  type GClientLive,
  type GClientRow,
  type GOwner,
  type GServer,
  type GService,
  type GSyncState,
  G_SERVICES,
} from '@vps/protocol';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { gclientBindings, gclientDevices, gclients, openfluxDocs, servers } from '../db/schema.js';
import { extServers, extsByClient } from '../lib/browser-ext.js';
import { ClientStatsHub, liveOnServer } from '../lib/client-stats.js';
import { extensionVersion } from '../lib/extension.js';
import { clientSlug, newClientToken, newXuiSubId } from '../lib/gclient-names.js';
import { awgRef, wdttKey } from '../lib/gclient-services.js';
import { type GClients, PANEL_HOST_KEY, queued } from '../lib/gclients.js';
import { newId } from '../lib/ids.js';
import { addOfDocs } from '../lib/openflux-docs.js';
import type { SecretBox } from '../lib/secret-box.js';
import { putSetting } from '../lib/settings.js';
import { savedXuiToken } from '../lib/xui-token.js';

const Id = z.object({ id: z.string() });
const Name = z.string().trim().min(1, 'имя обязательно').max(64);
const DeviceBody = z.object({
  name: z.string().trim().max(64).default(''),
  type: z.enum(DEVICE_IDS).or(z.literal('')).default(''),
  awg20: z.boolean().default(false),
});
/** Доступ клиента: null - все серверы и сервисы, список - только отмеченное. */
const AccessBody = z
  .array(
    z.object({
      serverId: z.string().min(1),
      services: z.array(z.enum(G_SERVICES as [GService, ...GService[]])),
    }),
  )
  .max(200)
  .nullable()
  .transform((list): GClientAccess => {
    if (!list) return null;
    // пустые строки не храним, повторы сервисов - один раз
    return list
      .map((a) => ({ serverId: a.serverId, services: [...new Set(a.services)] }))
      .filter((a) => a.services.length > 0);
  });

/** Глобальные клиенты: люди, устройства, привязки; сверку делает GClients. */
export async function gclientRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; box: SecretBox; gc: GClients; env: Env },
) {
  const { db, registry, box, gc, env } = opts;
  /** Адрес подписок: отдельное имя (SUB_PUBLIC_URL) или временно - адрес панели. */
  const subBase = (env.SUB_PUBLIC_URL ?? env.PANEL_PUBLIC_URL).replace(/\/+$/, '');

  /** Изменилось то, что видит сервер (имя, вкл/выкл): привязки клиента - в очередь сверки. */
  function touch(clientId: string) {
    db.update(gclientBindings)
      .set({ ...queued(), error: '' })
      .where(eq(gclientBindings.clientId, clientId))
      .run();
    gc.kick();
  }

  /** Устройства человека поменялись - лимит устройств его паролей WDTT пересчитает сверка. */
  function touchWdtt(clientId: string) {
    db.update(gclientBindings)
      .set(queued())
      .where(and(eq(gclientBindings.clientId, clientId), eq(gclientBindings.service, 'wdtt')))
      .run();
  }

  function getClient(id: string) {
    const c = db.select().from(gclients).where(eq(gclients.id, id)).get();
    if (!c || c.deletedAt) throw Object.assign(new Error('клиент не найден'), { statusCode: 404 });
    return c;
  }

  const serverNames = () =>
    new Map(
      db
        .select()
        .from(servers)
        .all()
        .map((s) => [s.id, s.name]),
    );

  /**
   * Пул документов OpenFlux: ссылки на документы с редактированием по ссылке,
   * каждый выдаётся одному каналу клиента. Список - с тем, кому выдан.
   */
  app.get('/api/openflux/docs', async () => {
    const names = serverNames();
    const rows = db
      .select({ d: openfluxDocs, b: gclientBindings, c: gclients })
      .from(openfluxDocs)
      .leftJoin(gclientBindings, eq(gclientBindings.id, openfluxDocs.bindingId))
      .leftJoin(gclients, eq(gclients.id, gclientBindings.clientId))
      .orderBy(openfluxDocs.createdAt)
      .all();
    const devices = new Map(
      db
        .select()
        .from(gclientDevices)
        .all()
        .map((d) => [d.id, d.name]),
    );
    return rows.map(({ d, b, c }) => ({
      id: d.id,
      kind: d.kind,
      url: d.url,
      usedBy: b
        ? {
            client: c?.name ?? '',
            device: (b.deviceId && devices.get(b.deviceId)) || '',
            server: names.get(b.serverId) ?? '',
          }
        : null,
    }));
  });
  /** Добавить документы: по ссылке на строку. Каналы клиентов без документа - в очередь сверки. */
  app.post('/api/openflux/docs', async (req) => {
    const { text } = z.object({ text: z.string().max(100_000) }).parse(req.body ?? {});
    const r = addOfDocs(db, text);
    if (r.added) {
      db.update(gclientBindings).set(queued()).where(eq(gclientBindings.service, 'openflux')).run();
      gc.kick();
    }
    return r;
  });
  /** Убрать документ из пула; выданный - его канал перенастроится без него. */
  app.delete('/api/openflux/docs/:did', async (req) => {
    const { did } = z.object({ did: z.string() }).parse(req.params);
    const d = db.select().from(openfluxDocs).where(eq(openfluxDocs.id, did)).get();
    if (!d) throw Object.assign(new Error('документ не найден'), { statusCode: 404 });
    db.delete(openfluxDocs).where(eq(openfluxDocs.id, did)).run();
    if (d.bindingId) {
      db.update(gclientBindings).set(queued()).where(eq(gclientBindings.id, d.bindingId)).run();
      gc.kick();
    }
    return { ok: true };
  });

  app.get('/api/gclients', async (): Promise<GClientRow[]> => {
    const names = serverNames();
    const devices = db.select().from(gclientDevices).where(isNull(gclientDevices.deletedAt)).all();
    const bindings = db.select().from(gclientBindings).all();
    return db
      .select()
      .from(gclients)
      .where(isNull(gclients.deletedAt))
      .all()
      .map((c) => {
        const mine = bindings.filter((b) => b.clientId === c.id);
        return {
          id: c.id,
          name: c.name,
          note: c.note,
          enabled: c.enabled,
          createdAt: c.createdAt,
          devices: devices.filter((d) => d.clientId === c.id),
          states: {
            ok: mine.filter((b) => b.state === 'ok').length,
            pending: mine.filter((b) => b.state === 'pending').length,
            error: mine.filter((b) => b.state === 'error').length,
          },
          servers: [...new Set(mine.map((b) => names.get(b.serverId) ?? b.serverId))],
          limited: c.access !== null,
          access: c.access,
        };
      });
  });

  app.get('/api/gclients/:id', async (req): Promise<GClientDetail> => {
    const c = getClient(Id.parse(req.params).id);
    const names = serverNames();
    return {
      client: c,
      syncing: gc.syncing,
      subscription: {
        url: `${subBase}/sub/${c.token}`,
        page: `${subBase}/c/${c.token}`,
        temporary: !env.SUB_PUBLIC_URL,
      },
      devices: db
        .select()
        .from(gclientDevices)
        .where(and(eq(gclientDevices.clientId, c.id), isNull(gclientDevices.deletedAt)))
        .all(),
      bindings: db
        .select()
        .from(gclientBindings)
        .where(eq(gclientBindings.clientId, c.id))
        .all()
        .map(
          ({ secret: _, links, ...b }): GBinding => ({
            ...b,
            service: b.service as GService,
            state: b.state as GBindingState,
            linkCount: links.length,
            serverName: names.get(b.serverId) ?? b.serverId,
            // ref AWG разобран здесь: интерфейс не знает формата "версия|контейнер|ключ"
            awg: b.service === 'awg' ? awgRef(b.ref) : null,
          }),
        ),
      browserExt:
        extsByClient(db, [c.id], extensionVersion(env.EXTENSION_DIR), (sid) =>
          registry.isOnline(sid),
        ).get(c.id) ?? [],
    };
  });

  /** Снимки clients.stats серверов: общие для всех карточек клиентов. */
  const live = new ClientStatsHub({
    registry,
    xuiToken: (serverId) => {
      try {
        return savedXuiToken(db, box, serverId);
      } catch {
        return '';
      }
    },
  });

  /**
   * Живая статистика клиента: подключение и трафик по привязкам. Карточка опрашивает раз в 3 с,
   * пока открыта; агента спрашивают не чаще раза в 2,5 с на сервер. Чтение - в журнал действий
   * не пишется; ключи записей (пароль WDTT - только хешем) в ответ не попадают.
   */
  app.get('/api/gclients/:id/live', async (req, reply): Promise<GClientLive> => {
    const c = getClient(Id.parse(req.params).id);
    // ?server= - только этот сервер (страница клиента на сервере)
    const { server } = z.object({ server: z.string().max(64).optional() }).parse(req.query);
    const rows = db
      .select()
      .from(gclientBindings)
      .where(eq(gclientBindings.clientId, c.id))
      .all()
      .filter((b) => !server || b.serverId === server);
    const ids = [...new Set(rows.map((b) => b.serverId))];
    const snaps = new Map(
      await Promise.all(ids.map(async (id) => [id, await live.server(id)] as const)),
    );
    reply.header('Cache-Control', 'no-store');
    const bindings = rows.flatMap((b) => {
      const s = snaps.get(b.serverId);
      if (!s) return [];
      let key = b.ref;
      if (b.service === 'wdtt') {
        try {
          key = b.secret ? wdttKey(box.open(b.secret)) : '';
        } catch {
          key = '';
        }
      }
      return [liveOnServer({ id: b.id, service: b.service as GService, ref: b.ref, key }, s)];
    });
    // прокси для браузера: подключений сервер не показывает - "на связи" по отчёту расширения
    const naive = new Map(
      rows
        .filter((b) => b.service === 'naive')
        .map((b) => [b.serverId, bindings.find((l) => l.bindingId === b.id)] as const),
    );
    const exts = extServers(db, c.id, c.token, (sid) => naive.get(sid)?.state === 'running');
    for (const [sid, e] of exts) {
      const l = naive.get(sid);
      if (l?.state !== 'running') continue;
      l.state = 'online';
      l.lastSeen = e.seenAt;
      l.note = `расширение ${e.browser === 'firefox' ? 'Firefox' : 'Chrome'} ${e.version} включено${e.auto ? ' (\u00abАвто\u00bb: первый доступный сервер)' : ''}`;
    }
    return {
      at: new Date().toISOString(),
      servers: [...snaps.values()].map((s) => s.info),
      bindings,
    };
  });

  /** Ссылки привязки из кэша (MTProxy - tg:// и t.me): в них секрет, не кэшируются браузером. */
  app.get('/api/gclients/:id/links/:bid', async (req, reply) => {
    const { id, bid } = z.object({ id: z.string(), bid: z.string() }).parse(req.params);
    getClient(id);
    const b = db
      .select()
      .from(gclientBindings)
      .where(and(eq(gclientBindings.id, bid), eq(gclientBindings.clientId, id)))
      .get();
    if (!b) return reply.code(404).send({ error: 'привязка не найдена' });
    reply.header('Cache-Control', 'no-store');
    const out: GBindingLinks = { links: b.links };
    // порядок ссылок WDTT задаёт сверка (lib/gclients.ts, wdttEnsure): qwdtt://, затем wdtt://
    if (b.service === 'wdtt') out.wdtt = { qwdtt: b.links[0] ?? '', wdtt: b.links[1] ?? '' };
    return out;
  });

  app.post('/api/gclients', async (req) => {
    const body = z
      .object({
        name: Name,
        note: z.string().max(500).default(''),
        devices: z.array(DeviceBody).max(20).default([]),
        access: AccessBody.default(null),
      })
      .parse(req.body ?? {});
    const id = newId();
    db.insert(gclients)
      .values({
        id,
        name: body.name,
        note: body.note,
        access: body.access,
        slug: clientSlug(body.name),
        token: newClientToken(),
        xuiSubId: newXuiSubId(),
      })
      .run();
    for (const d of body.devices)
      db.insert(gclientDevices)
        .values({ id: newId(), clientId: id, ...d })
        .run();
    gc.kick();
    return { id };
  });

  app.patch('/api/gclients/:id', async (req) => {
    const c = getClient(Id.parse(req.params).id);
    const body = z
      .object({
        name: Name.optional(),
        note: z.string().max(500).optional(),
        enabled: z.boolean().optional(),
        access: AccessBody.optional(),
      })
      .parse(req.body ?? {});
    db.update(gclients)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
        ...(body.access !== undefined ? { access: body.access } : {}),
      })
      .where(eq(gclients.id, c.id))
      .run();
    // доступ сузили - сверка уберёт лишнее с серверов, расширили - заведёт новое
    if (body.name !== undefined || body.enabled !== undefined || body.access !== undefined)
      touch(c.id);
    return { ok: true };
  });

  /**
   * Новая ссылка: новый токен подписки и личной страницы, старый перестаёт работать
   * сразу. На серверах ничего не меняется - токен живёт только в панели.
   */
  app.post('/api/gclients/:id/rotate-token', async (req) => {
    const c = getClient(Id.parse(req.params).id);
    const token = newClientToken();
    db.update(gclients).set({ token }).where(eq(gclients.id, c.id)).run();
    return { url: `${subBase}/sub/${token}`, page: `${subBase}/c/${token}` };
  });

  /** Удаление мягкое: сверка убирает клиента с серверов, потом строку. */
  app.delete('/api/gclients/:id', async (req) => {
    const c = getClient(Id.parse(req.params).id);
    db.update(gclients)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(gclients.id, c.id))
      .run();
    touch(c.id);
    return { ok: true };
  });

  app.post('/api/gclients/:id/devices', async (req) => {
    const c = getClient(Id.parse(req.params).id);
    const body = DeviceBody.parse(req.body ?? {});
    const id = newId();
    db.insert(gclientDevices)
      .values({ id, clientId: c.id, ...body })
      .run();
    touchWdtt(c.id);
    gc.kick();
    return { id };
  });

  app.patch('/api/gclients/:id/devices/:did', async (req) => {
    const { id, did } = z.object({ id: z.string(), did: z.string() }).parse(req.params);
    getClient(id);
    const body = DeviceBody.partial().parse(req.body ?? {});
    db.update(gclientDevices)
      .set(body)
      .where(and(eq(gclientDevices.id, did), eq(gclientDevices.clientId, id)))
      .run();
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.deviceId, did)).run();
    touchWdtt(id);
    gc.kick();
    return { ok: true };
  });

  app.delete('/api/gclients/:id/devices/:did', async (req) => {
    const { id, did } = z.object({ id: z.string(), did: z.string() }).parse(req.params);
    getClient(id);
    db.update(gclientDevices)
      .set({ deletedAt: new Date().toISOString() })
      .where(and(eq(gclientDevices.id, did), eq(gclientDevices.clientId, id)))
      .run();
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.deviceId, did)).run();
    touchWdtt(id);
    gc.kick();
    return { ok: true };
  });

  /**
   * Сверить сейчас. all - полная сверка всех клиентов: каждая привязка каждого сервиса - заново
   * (записи на серверах приводятся к панели); clientId - то же для одного клиента; без них -
   * повтор ошибок и ссылки VLESS.
   */
  app.post('/api/gclients/sync', async (req) => {
    const body = z
      .object({ all: z.boolean().optional(), clientId: z.string().optional() })
      .parse(req.body ?? {});
    db.update(gclientBindings)
      .set(queued())
      .where(
        body.all
          ? undefined
          : body.clientId
            ? eq(gclientBindings.clientId, body.clientId)
            : or(eq(gclientBindings.state, 'error'), eq(gclientBindings.service, 'xui')),
      )
      .run();
    gc.kick();
    return { ok: true };
  });
  /** Идёт ли сверка: по нему кнопки "Сверить" крутятся до её конца. */
  app.get(
    '/api/gclients/syncing',
    async (): Promise<GSyncState> => ({
      syncing: gc.syncing,
      stopping: gc.stopping,
      startedAt: gc.startedAt,
      progress: [...gc.progress.entries()]
        .map(([server, p]) => ({ server, ...p, finished: Boolean(p.finished) }))
        .sort((a, b) => a.server.localeCompare(b.server)),
    }),
  );
  /** Прервать сверку: серверы заканчивают текущую операцию; остальное - следующей сверкой. */
  app.post('/api/gclients/sync/stop', async () => ({ ok: gc.stop() }));

  /** Чьи записи в сервисах сервера: для ссылок на клиента во вкладках сервисов. */
  app.get('/api/servers/:id/gclient-owners', async (req): Promise<GOwner[]> => {
    const { id } = Id.parse(req.params);
    const devices = new Map(
      db
        .select()
        .from(gclientDevices)
        .all()
        .map((d) => [d.id, d.name]),
    );
    const out: GOwner[] = [];
    for (const { b, c } of db
      .select({ b: gclientBindings, c: gclients })
      .from(gclientBindings)
      .innerJoin(gclients, eq(gclients.id, gclientBindings.clientId))
      .where(and(eq(gclientBindings.serverId, id), isNull(gclients.deletedAt)))
      .all()) {
      let key = b.ref;
      if (b.service === 'awg') key = awgRef(b.ref).publicKey;
      if (b.service === 'wdtt') {
        try {
          key = b.secret ? wdttKey(box.open(b.secret)) : '';
        } catch {
          key = '';
        }
      }
      if (!key) continue;
      out.push({
        service: b.service as GService,
        key,
        clientId: c.id,
        client: c.name,
        device: (b.deviceId && devices.get(b.deviceId)) || '',
      });
    }
    return out;
  });

  /** Серверы и их участие в глобальных клиентах. */
  app.get(
    '/api/gclients/servers',
    async (): Promise<GServer[]> =>
      (await gc.serverStates()).map((t) => ({
        id: t.row.id,
        name: t.row.name,
        online: t.online,
        enabled: t.active,
        active: t.active,
        panelHost: t.panelHost,
        ...t.has,
        xuiExcluded: t.row.xuiExcluded,
      })),
  );

  app.patch('/api/servers/:id/gclients', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    // сервер панели: участие - отдельным признаком (явное включение владельцем)
    const st = (await gc.serverStates()).find((t) => t.row.id === id);
    if (st?.panelHost) putSetting(db, PANEL_HOST_KEY, body.enabled ? '1' : '');
    db.update(servers).set({ gclients: body.enabled }).where(eq(servers.id, id)).run();
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, id)).run();
    gc.kick();
    return { ok: true };
  });
}
