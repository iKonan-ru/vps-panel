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
  type XuiClientRow,
} from '@vps/protocol';
import { and, eq, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { gclientBindings, gclientDevices, gclients, openfluxDocs, servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import { ClientStatsHub, liveOnServer } from '../lib/client-stats.js';
import { clientSlug, newClientToken, newXuiSubId } from '../lib/gclient-names.js';
import { awgRef, wdttKey, xuiTargets } from '../lib/gclient-services.js';
import { type GClients, queued } from '../lib/gclients.js';
import { newId } from '../lib/ids.js';
import { addOfDocs } from '../lib/openflux-docs.js';
import type { SecretBox } from '../lib/secret-box.js';
import type { UiHub } from '../lib/ui-hub.js';
import { ownVlessInbounds, parseJson, readClient, unwrap, xuiApi } from '../lib/xui-api.js';
import { savedXuiToken, xuiToken } from '../lib/xui-token.js';

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
  opts: { db: Db; registry: AgentRegistry; box: SecretBox; gc: GClients; env: Env; hub: UiHub },
) {
  const { db, registry, box, gc, env, hub } = opts;
  const journal = actionJournal(db, hub, registry);
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
    if (!c || c.deletedAt) throw Object.assign(new Error('Клиент не найден'), { statusCode: 404 });
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
    if (!d) throw Object.assign(new Error('Документ не найден'), { statusCode: 404 });
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
    const rows = db.select().from(gclientBindings).where(eq(gclientBindings.clientId, c.id)).all();
    const ids = [...new Set(rows.map((b) => b.serverId))];
    const snaps = new Map(
      await Promise.all(ids.map(async (id) => [id, await live.server(id)] as const)),
    );
    reply.header('Cache-Control', 'no-store');
    return {
      at: new Date().toISOString(),
      servers: [...snaps.values()].map((s) => s.info),
      bindings: rows.flatMap((b) => {
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
      }),
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
    if (!b) return reply.code(404).send({ error: 'Привязка не найдена' });
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

  /** REST 3X-UI сервера с сохранённым токеном (нет - 409 no-token: вкладка предложит выпустить). */
  function xuiFor(id: string) {
    if (!registry.isOnline(id))
      throw Object.assign(new Error('Агент не подключён'), { statusCode: 409 });
    const token = savedXuiToken(db, box, id);
    if (!token)
      throw Object.assign(new Error('Нет API-токена 3X-UI: выпусти его кнопкой'), {
        statusCode: 409,
        code: 'no-token',
      });
    return xuiApi(registry, id, token);
  }

  /** Привязки VLESS сервера к живым клиентам панели: email (ref) -> привязка и клиент. */
  function xuiBindings(serverId: string) {
    return new Map(
      db
        .select({ b: gclientBindings, c: gclients })
        .from(gclientBindings)
        .innerJoin(gclients, eq(gclients.id, gclientBindings.clientId))
        .where(
          and(
            eq(gclientBindings.serverId, serverId),
            eq(gclientBindings.service, 'xui'),
            isNull(gclients.deletedAt),
          ),
        )
        .all()
        .map((r) => [r.b.ref, r]),
    );
  }

  /** Клиенты 3X-UI для вкладки: inbound-ы, трафик, онлайн, клиент панели (без UUID и subId). */
  app.get('/api/servers/:id/xui/clients', async (req, reply): Promise<XuiClientRow[]> => {
    const { id } = Id.parse(req.params);
    let api: ReturnType<typeof xuiApi>;
    try {
      api = xuiFor(id);
    } catch (e) {
      const err = e as Error & { statusCode: number; code?: string };
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    const list = (unwrap(await api('GET', 'clients/list'), 'clients/list') ?? []) as Record<
      string,
      unknown
    >[];
    let online = new Set<string>();
    try {
      online = new Set(
        ((unwrap(await api('POST', 'clients/onlines'), 'clients/onlines') as string[]) ?? []).map(
          String,
        ),
      );
    } catch {
      // без онлайна
    }
    const panel = xuiBindings(id);
    return list.map((c) => {
      const email = String(c.email ?? '');
      const t = (c.traffic ?? {}) as Record<string, unknown>;
      const p = panel.get(email);
      return {
        email,
        comment: String(c.comment ?? ''),
        enable: c.enable !== false,
        inboundIds: ((c.inboundIds as number[] | undefined) ?? []).map(Number),
        up: Number(t.up ?? 0),
        down: Number(t.down ?? 0),
        totalGB: Number(c.totalGB ?? 0),
        expiryTime: Number(c.expiryTime ?? 0),
        online: online.has(email),
        panel: p ? { clientId: p.c.id, name: p.c.name, custom: p.b.xuiInbounds !== null } : null,
      };
    });
  });

  /**
   * Inbound-ы клиента 3X-UI: привязать и отвязать по разнице (attach/detach), в журнале. У клиента
   * панели набор запоминается в привязке (xui_inbounds), и сверка его держит; совпал с общим
   * (свои VLESS минус исключённые) или reset - снова "как у всех" (новые inbound-ы - сами).
   */
  app.post('/api/servers/:id/xui/clients/:email/inbounds', async (req) => {
    const { id, email } = z
      .object({ id: z.string(), email: z.string().min(1).max(200) })
      .parse(req.params);
    const body = z
      .object({
        inboundIds: z.array(z.number().int().positive()).max(100).default([]),
        reset: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw Object.assign(new Error('Сервер не найден'), { statusCode: 404 });
    const api = xuiFor(id);
    const inbounds = (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') ?? []) as Record<
      string,
      unknown
    >[];
    const p = xuiBindings(id).get(email);
    const def = xuiTargets(inbounds, row.xuiExcluded).target;
    const want = body.reset ? def : [...new Set(body.inboundIds)];
    if (!want.length)
      throw Object.assign(
        new Error(
          'Нужен хотя бы один inbound. Убрать клиента панели с сервера - в его карточке (Доступ)',
        ),
        { statusCode: 400 },
      );
    const allowed = new Set((p ? ownVlessInbounds(inbounds) : inbounds).map((i) => Number(i.id)));
    const bad = want.filter((i) => !allowed.has(i));
    if (bad.length)
      throw Object.assign(
        new Error(
          p
            ? `клиенту панели - только свои VLESS-inbound-ы сервера (не подходят: ${bad.join(', ')})`
            : `нет таких inbound-ов: ${bad.join(', ')}`,
        ),
        { statusCode: 400 },
      );
    const actionId = await journal.start(id, 'xui:client.inbounds', {
      email,
      inbounds: want,
      ...(body.reset ? { reset: true } : {}),
    });
    try {
      const cur = readClient(
        unwrap(await api('GET', `clients/get/${encodeURIComponent(email)}`), 'clients/get'),
      );
      if (!cur) throw Object.assign(new Error('клиент не найден в 3X-UI'), { statusCode: 404 });
      const add = want.filter((i) => !cur.inboundIds.includes(i));
      const del = cur.inboundIds.filter((i) => !want.includes(i));
      if (add.length)
        unwrap(
          await api('POST', `clients/${encodeURIComponent(email)}/attach`, { inboundIds: add }),
          'attach',
        );
      if (del.length)
        unwrap(
          await api('POST', `clients/${encodeURIComponent(email)}/detach`, { inboundIds: del }),
          'detach',
        );
      let note = '';
      if (p) {
        const same = want.length === def.length && want.every((i) => def.includes(i));
        // ссылки подписки - заново сверкой (набор inbound-ов изменился)
        db.update(gclientBindings)
          .set({ ...queued(), xuiInbounds: same ? null : want })
          .where(eq(gclientBindings.id, p.b.id))
          .run();
        gc.kick();
        note = same ? ', набор как у всех' : ', свой набор клиента панели';
      }
      await journal.finish(
        actionId,
        id,
        0,
        `привязано ${add.length ? add.join(', ') : '-'}, отвязано ${del.length ? del.join(', ') : '-'}${note}`,
      );
      return { ok: true };
    } catch (e) {
      await journal.finish(actionId, id, 1, (e as Error).message);
      const code = (e as { statusCode?: unknown }).statusCode;
      throw Object.assign(new Error((e as Error).message), {
        statusCode: typeof code === 'number' ? code : 502,
      });
    }
  });

  /**
   * Удалить клиента 3X-UI (clients/del), в журнале. Клиента панели здесь не удалить - сверка
   * заведёт его снова: убирают его в карточке клиента (доступ или удаление).
   */
  app.delete('/api/servers/:id/xui/clients/:email', async (req) => {
    const { id, email } = z
      .object({ id: z.string(), email: z.string().min(1).max(200) })
      .parse(req.params);
    const p = xuiBindings(id).get(email);
    if (p)
      throw Object.assign(
        new Error(
          `"${email}" - клиент панели (${p.c.name}): сверка заведёт его снова. Убрать VLESS на сервере или самого клиента - в его карточке`,
        ),
        { statusCode: 409 },
      );
    const api = xuiFor(id);
    const actionId = await journal.start(id, 'xui:client.del', { email });
    try {
      unwrap(await api('POST', `clients/del/${encodeURIComponent(email)}`), 'clients/del');
      await journal.finish(actionId, id, 0, 'удалён');
      return { ok: true };
    } catch (e) {
      await journal.finish(actionId, id, 1, (e as Error).message);
      throw Object.assign(new Error((e as Error).message), { statusCode: 502 });
    }
  });

  /** Серверы и их участие в глобальных клиентах. */
  app.get(
    '/api/gclients/servers',
    async (): Promise<GServer[]> =>
      (await gc.serverStates()).map((t) => ({
        id: t.row.id,
        name: t.row.name,
        online: t.online,
        enabled: t.row.gclients,
        active: t.active,
        panelHost: t.panelHost,
        xui: t.xui,
        awg: t.awg,
        mtproxyl: t.mtproxyl,
        wdtt: t.wdtt,
        openflux: t.openflux,
        naive: t.naive,
        xuiExcluded: t.row.xuiExcluded,
      })),
  );

  app.patch('/api/servers/:id/gclients', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ enabled: z.boolean() }).parse(req.body ?? {});
    db.update(servers).set({ gclients: body.enabled }).where(eq(servers.id, id)).run();
    db.update(gclientBindings).set(queued()).where(eq(gclientBindings.serverId, id)).run();
    gc.kick();
    return { ok: true };
  });

  /** VLESS-inbound-ы сервера (свои, не других узлов группы 3X-UI) и отметка "без глобальных клиентов". */
  app.get('/api/servers/:id/xui/inbounds', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'Сервер не найден' });
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'Агент не подключён' });
    const api = xuiApi(registry, id, await xuiToken(db, box, registry, id));
    const list =
      (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<string, unknown>[]) ??
      [];
    return ownVlessInbounds(list).map((i) => ({
      id: Number(i.id),
      remark: String(i.remark ?? ''),
      port: Number(i.port),
      enable: i.enable !== false,
      security: String(parseJson(i.streamSettings).security ?? ''),
      excluded: row.xuiExcluded.includes(Number(i.id)),
    }));
  });

  app.put('/api/servers/:id/xui/excluded', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ inboundIds: z.array(z.number().int()).max(200) }).parse(req.body ?? {});
    db.update(servers).set({ xuiExcluded: body.inboundIds }).where(eq(servers.id, id)).run();
    db.update(gclientBindings)
      .set(queued())
      .where(and(eq(gclientBindings.serverId, id), eq(gclientBindings.service, 'xui')))
      .run();
    gc.kick();
    return { ok: true };
  });
}
