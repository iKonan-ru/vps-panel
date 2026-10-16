import type { XuiClientRow } from '@vps/protocol';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireOnline } from '../agents/registry.js';
import { listenersOf as listenersIn } from '../agents/state.js';
import { access, gclientBindings, gclients, servers } from '../db/schema.js';
import { upsertAccess } from '../lib/access.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { xuiTargets } from '../lib/gclient-services.js';
import { type GClients, queued, resyncXui } from '../lib/gclients.js';
import { type InboundExitHooks, telegramExitOf } from '../lib/xray-exits.js';
import {
  getInbound,
  inboundNode,
  listInbounds,
  ownVlessInbounds,
  parseJson,
  readClient,
  streamOf,
  unwrap,
  xuiApi,
} from '../lib/xui-api.js';
import { portBusy } from '../lib/xui-new-inbound.js';
import { saveXuiToken, xuiFor, xuiToken } from '../lib/xui-token.js';

const Id = z.object({ id: z.string() });

/** Адаптер 3X-UI: информация, настройки панели, служба, обновление, токен API, статус. */
export async function xuiRoutes(
  app: FastifyInstance,
  opts: ServerRouteOpts & InboundExitHooks & { gc: Pick<GClients, 'kick'> },
) {
  const { db, registry, hub, box, xray, exitsAfter, syncSpares, gc } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);

  app.get('/api/servers/:id/xui', async (req) => {
    const { id } = Id.parse(req.params);
    return registry.request(id, 'xui.info', {}, { timeoutMs: 60_000 });
  });
  app.post('/api/servers/:id/xui/set', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z
      .object({
        port: z.number().int().min(1).max(65535).optional(),
        username: z.string().max(64).optional(),
        password: z.string().max(128).optional(),
        basePath: z.string().max(80).optional(),
        listen: z.string().max(64).optional(),
        resetTwoFactor: z.boolean().optional(),
      })
      .parse(req.body ?? {});
    // пароль в журнал не пишется
    const actionId = await runStreamed(id, 'xui:set', 'xui.set', body, 5 * 60_000, {
      ...body,
      password: body.password ? '********' : undefined,
    });
    if (body.username || body.password) {
      // новые логин/пароль - в "Доступы", вместе с уже известным адресом
      const cur = (
        await db
          .select()
          .from(access)
          .where(and(eq(access.serverId, id), eq(access.kind, 'xui')))
          .limit(1)
      )[0];
      const fields = (cur?.fields ?? []).map((f) => ({ ...f, value: box.open(f.value) }));
      const set = (label: string, value: string, secret = false) => {
        const i = fields.findIndex((f) => f.label === label);
        if (i >= 0) fields[i] = { label, value, ...(fields[i]?.secret ? { secret: true } : {}) };
        else fields.push({ label, value, ...(secret ? { secret: true } : {}) });
      };
      if (body.username) set('Логин', body.username);
      if (body.password) set('Пароль', body.password, true);
      await upsertAccess(db, box, id, { kind: 'xui', title: 'Панель 3X-UI', fields });
    }
    return { actionId };
  });
  app.post('/api/servers/:id/xui/service', async (req) => {
    const { id } = Id.parse(req.params);
    const { action } = z
      .object({ action: z.enum(['start', 'stop', 'restart', 'enable', 'disable', 'restart-xray']) })
      .parse(req.body ?? {});
    const actionId = await runStreamed(id, `xui:${action}`, 'xui.service', { action }, 5 * 60_000);
    return { actionId };
  });
  /** Мусор на диске: категории с размерами (агент считает по факту). */
  app.get('/api/servers/:id/cleanup', async (req) => {
    const { id } = Id.parse(req.params);
    return registry.request(id, 'disk.cleanup.scan', {}, { timeoutMs: 120_000 });
  });
  /** Очистка выбранных категорий: длинное действие с выводом. */
  app.post('/api/servers/:id/cleanup', async (req) => {
    const { id } = Id.parse(req.params);
    const body = z.object({ ids: z.array(z.string().max(40)).min(1).max(20) }).parse(req.body);
    const actionId = await runStreamed(
      id,
      'cleanup',
      'disk.cleanup.run',
      { ids: body.ids },
      30 * 60_000,
    );
    return { actionId };
  });
  app.post('/api/servers/:id/xui/update', async (req) => {
    const { id } = Id.parse(req.params);
    const actionId = await runStreamed(id, 'xui:update', 'xui.update', {}, 20 * 60_000);
    return { actionId };
  });
  /** Выпуск API-токена панели: агент зовёт x-ui setting -getApiToken, токен хранится в панели (служебная запись "Доступов", не показывается). */
  app.post('/api/servers/:id/xui/token', async (req) => {
    const { id } = Id.parse(req.params);
    const r = await quickAction<{ token: string }>(id, 'xui:token', 'xui.token', {}, 60_000);
    await saveXuiToken(db, box, id, r.token);
    return { ok: true };
  });
  const apiFor = (id: string) => xuiFor(db, box, registry, id);
  const listenersOf = (id: string) => listenersIn(db, id);

  /**
   * Inbound-ы 3X-UI для вкладки: без настроек клиентов (UUID в браузер не уходят) - число
   * клиентов, онлайн (clients/onlines), клиенты панели (email = ref привязок VLESS), трафик.
   */
  app.get('/api/servers/:id/xui/inbound-list', async (req) => {
    const { id } = Id.parse(req.params);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    const api = apiFor(id);
    const list = await listInbounds(api);
    let online = new Set<string>();
    try {
      online = new Set(
        ((unwrap(await api('POST', 'clients/onlines'), 'clients/onlines') as string[]) ?? []).map(
          String,
        ),
      );
    } catch {
      // старые версии без onlines - без онлайна
    }
    const panelEmails = new Set(
      db
        .select()
        .from(gclientBindings)
        .where(and(eq(gclientBindings.serverId, id), eq(gclientBindings.service, 'xui')))
        .all()
        .map((b) => b.ref),
    );
    const exits = xray.exits();
    return list.map((i) => {
      const st = streamOf(i);
      const reality = parseJson(st.realitySettings);
      const tls = parseJson(st.tlsSettings);
      const clients = ((parseJson(i.settings).clients as Record<string, unknown>[]) ?? []).map(
        (c) => ({ email: String(c.email ?? ''), enable: c.enable !== false }),
      );
      const names = (reality.serverNames as string[] | undefined) ?? [];
      return {
        id: Number(i.id),
        remark: String(i.remark ?? ''),
        enable: i.enable !== false,
        protocol: String(i.protocol ?? ''),
        port: Number(i.port ?? 0),
        listen: String(i.listen ?? ''),
        network: String(st.network ?? ''),
        security: String(st.security ?? ''),
        sni: String(names[0] ?? tls.serverName ?? ''),
        node: Boolean(inboundNode(i)),
        up: Number(i.up ?? 0),
        down: Number(i.down ?? 0),
        total: Number(i.total ?? 0),
        expiryTime: Number(i.expiryTime ?? 0),
        excludeFromSub: i.excludeFromSub === true,
        excluded: row.xuiExcluded.includes(Number(i.id)),
        clients: clients.length,
        clientsOff: clients.filter((c) => !c.enable).length,
        online: clients.filter((c) => online.has(c.email)).length,
        panelClients: clients.filter((c) => panelEmails.has(c.email)).length,
        telegramExit: telegramExitOf(exits, id, Number(i.id)),
      };
    });
  });

  /**
   * Включение и выключение inbound-а. Подпись, порт и Reality правит окно правки
   * (routes/xui-inbounds.ts): там же проверка Xray и откат.
   */
  app.post('/api/servers/:id/xui/inbounds/:iid', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const { enable } = z.object({ enable: z.boolean() }).parse(req.body ?? {});
    const api = apiFor(id);
    const changed = await journal.quick(
      id,
      'xui:inbound',
      { inbound: iid, enable },
      async () => {
        const got = await getInbound(api, iid);
        if (!got) throw Object.assign(new Error('inbound не найден'), { statusCode: 404 });
        if (enable === (got.enable !== false)) return null;
        if (enable) {
          // включение на занятом порту останавливает весь Xray; сам Xray в снимке не считается -
          // только что выключенный inbound он ещё может слушать
          const others = (await listInbounds(api)).filter(
            (x) => Number(x.id) !== iid && x.enable !== false,
          );
          const ls = listenersOf(id).filter((l) => !/xray/i.test(l.process));
          const busy = portBusy(Number(got.port), others, ls);
          if (busy) throw Object.assign(new Error(busy), { statusCode: 409 });
        }
        unwrap(await api('POST', `inbounds/setEnable/${iid}`, { enable }), 'inbounds/setEnable');
        const done = [enable ? 'включён' : 'выключен'];
        if (enable) syncSpares();
        else done.push(...(await exitsAfter(id, iid, true)));
        return done;
      },
      (done) => (done ? done.join(', ') : 'без изменений'),
    );
    if (changed) resyncXui(db, gc, id);
    return { ok: true };
  });

  /**
   * Состояние 3X-UI и Xray по REST API: только этот запрос, без общего прокси к API 3X-UI -
   * изменения идут действиями с журналом.
   */
  app.get('/api/servers/:id/xui/status', async (req) => {
    const { id } = Id.parse(req.params);
    return unwrap(await apiFor(id)('GET', 'server/status'), 'server/status');
  });

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
  app.get('/api/servers/:id/xui/clients', async (req): Promise<XuiClientRow[]> => {
    const { id } = Id.parse(req.params);
    const api = apiFor(id);
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
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    const api = apiFor(id);
    const inbounds = await listInbounds(api);
    const p = xuiBindings(id).get(email);
    const def = xuiTargets(inbounds, row.xuiExcluded).target;
    const want = body.reset ? def : [...new Set(body.inboundIds)];
    if (!want.length)
      throw Object.assign(
        new Error('нужен хотя бы один inbound (клиента панели убирают с сервера в его карточке)'),
        { statusCode: 400 },
      );
    const allowed = new Set((p ? ownVlessInbounds(inbounds) : inbounds).map((i) => Number(i.id)));
    const bad = want.filter((i) => !allowed.has(i));
    if (bad.length)
      throw Object.assign(
        new Error(
          p
            ? `клиенту панели подходят только свои inbound VLESS сервера (не подходят: ${bad.join(', ')})`
            : `нет таких inbound: ${bad.join(', ')}`,
        ),
        { statusCode: 400 },
      );
    let kick = false;
    await journal.quick(
      id,
      'xui:client.inbounds',
      { email, inbounds: want, ...(body.reset ? { reset: true } : {}) },
      async () => {
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
          kick = true;
          note = same ? ', набор как у всех' : ', свой набор клиента панели';
        }
        return `привязано ${add.length ? add.join(', ') : '-'}, отвязано ${del.length ? del.join(', ') : '-'}${note}`;
      },
      (log) => log,
    );
    if (kick) gc.kick();
    return { ok: true };
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
          `\u00ab${email}\u00bb\u00a0\u2014 клиент панели (${p.c.name}), синхронизация создаст его снова. VLESS или самого клиента убирают в его карточке`,
        ),
        { statusCode: 409 },
      );
    const api = apiFor(id);
    await journal.quick(
      id,
      'xui:client.del',
      { email },
      async () => {
        unwrap(await api('POST', `clients/del/${encodeURIComponent(email)}`), 'clients/del');
      },
      () => 'удалён',
    );
    return { ok: true };
  });

  /** VLESS-inbound-ы сервера (свои, не других узлов группы 3X-UI) и отметка "без глобальных клиентов". */
  app.get('/api/servers/:id/xui/inbounds', async (req) => {
    const { id } = Id.parse(req.params);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    requireOnline(registry, id);
    const list = await listInbounds(xuiApi(registry, id, await xuiToken(db, box, registry, id)));
    return ownVlessInbounds(list).map((i) => ({
      id: Number(i.id),
      remark: String(i.remark ?? ''),
      port: Number(i.port),
      enable: i.enable !== false,
      security: String(streamOf(i).security ?? ''),
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
