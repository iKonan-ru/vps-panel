import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StatusCache } from '../agents/state.js';
import { access, gclientBindings, servers } from '../db/schema.js';
import { upsertAccess } from '../lib/access.js';
import { actionJournal } from '../lib/action-journal.js';
import { type ServerRouteOpts, actionRunners } from '../lib/action-runners.js';
import { type GClients, resyncXui } from '../lib/gclients.js';
import { type InboundExitHooks, telegramExitOf } from '../lib/xray-exits.js';
import { parseJson, unwrap, xuiApi } from '../lib/xui-api.js';
import { portBusy } from '../lib/xui-new-inbound.js';
import { saveXuiToken, savedXuiToken } from '../lib/xui-token.js';

const Id = z.object({ id: z.string() });

/** Адаптер 3X-UI: информация, настройки панели, служба, обновление, токен API, статус. */
export async function xuiRoutes(
  app: FastifyInstance,
  opts: ServerRouteOpts & InboundExitHooks & { gc: Pick<GClients, 'kick'> },
) {
  const { db, registry, hub, box, xray, exitsAfter, syncSpares, gc } = opts;
  const journal = actionJournal(db, hub, registry);
  const { runStreamed, quickAction } = actionRunners(registry, journal);

  app.get('/api/servers/:id/xui', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
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
  app.get('/api/servers/:id/cleanup', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
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
  /** Вызов REST 3X-UI с сохранённым токеном; нет токена - 409 no-token (вкладка предложит выпустить). */
  function apiFor(id: string) {
    if (!registry.isOnline(id))
      throw Object.assign(new Error('сервер не в сети'), { statusCode: 409 });
    const token = savedXuiToken(db, box, id);
    if (!token)
      throw Object.assign(new Error('нет API-токена 3X-UI: его нужно выпустить на вкладке 3X-UI'), {
        statusCode: 409,
        code: 'no-token',
      });
    return xuiApi(registry, id, token);
  }

  /**
   * Inbound-ы 3X-UI для вкладки: без настроек клиентов (UUID в браузер не уходят) - число
   * клиентов, онлайн (clients/onlines), клиенты панели (email = ref привязок VLESS), трафик.
   */
  app.get('/api/servers/:id/xui/inbound-list', async (req, reply) => {
    const { id } = Id.parse(req.params);
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) return reply.code(404).send({ error: 'сервер не найден' });
    let api: ReturnType<typeof xuiApi>;
    try {
      api = apiFor(id);
    } catch (e) {
      const err = e as Error & { statusCode: number; code?: string };
      return reply.code(err.statusCode).send({ error: err.message, code: err.code });
    }
    const list =
      (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<string, unknown>[]) ??
      [];
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
      const st = parseJson(i.streamSettings);
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
        node: Boolean(Number(i.nodeId ?? i.node_id ?? 0)),
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
   * Правка inbound-а: вкл/выкл (setEnable), подпись и порт (get -> update целиком: настройки и
   * клиенты как были). Порт проверяется: не занят другим inbound-ом и другим процессом (по отчёту
   * агента) - inbound на занятом порту роняет весь xray. Действие - в журнале.
   */
  app.post('/api/servers/:id/xui/inbounds/:iid', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = z
      .object({
        enable: z.boolean().optional(),
        remark: z.string().trim().max(100).optional(),
        port: z.number().int().min(1).max(65535).optional(),
      })
      .parse(req.body ?? {});
    const api = apiFor(id);
    const actionId = await journal.start(id, 'xui:inbound', { inbound: iid, ...body });
    try {
      const got = unwrap(await api('GET', `inbounds/get/${iid}`), 'inbounds/get') as Record<
        string,
        unknown
      >;
      if (!got) throw Object.assign(new Error('inbound не найден'), { statusCode: 404 });
      const done: string[] = [];
      if (
        body.remark !== undefined ||
        (body.port !== undefined && body.port !== Number(got.port))
      ) {
        if (body.port !== undefined && body.port !== Number(got.port)) {
          const list =
            (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<
              string,
              unknown
            >[]) ?? [];
          const other = list.find((x) => Number(x.id) !== iid && Number(x.port) === body.port);
          if (other)
            throw Object.assign(
              new Error(
                `порт ${body.port} уже занят inbound \u00ab${String(other.remark ?? other.id)}\u00bb`,
              ),
              { statusCode: 409 },
            );
          const row = db.select().from(servers).where(eq(servers.id, id)).get();
          const inv = (row?.statusCache as StatusCache | null)?.inventory;
          const busy = inv?.firewall.listeners.find(
            (l) => l.proto === 'tcp' && l.port === body.port && !/xray/i.test(l.process),
          );
          if (busy)
            throw Object.assign(new Error(`порт ${body.port} занят: ${busy.process}`), {
              statusCode: 409,
            });
        }
        const next = { ...got, remark: body.remark ?? got.remark, port: body.port ?? got.port };
        unwrap(await api('POST', `inbounds/update/${iid}`, next), 'inbounds/update');
        if (body.remark !== undefined) done.push('подпись');
        if (body.port !== undefined) done.push(`порт ${got.port} -> ${body.port}`);
      }
      if (body.enable === true && got.enable === false) {
        // пока inbound был выключен, его порт мог занять другой процесс: включение на занятом
        // порту останавливает весь Xray
        const others = (
          (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<
            string,
            unknown
          >[]) ?? []
        ).filter((x) => Number(x.id) !== iid && x.enable !== false);
        const row = db.select().from(servers).where(eq(servers.id, id)).get();
        // xray в снимке не считаем: только что выключенный inbound он ещё может слушать
        const ls = (
          (row?.statusCache as StatusCache | null)?.inventory?.firewall.listeners ?? []
        ).filter((l) => !/xray/i.test(l.process));
        const busy = portBusy(Number(got.port), others, ls);
        if (busy) throw Object.assign(new Error(busy), { statusCode: 409 });
      }
      if (body.enable !== undefined && body.enable !== (got.enable !== false)) {
        unwrap(
          await api('POST', `inbounds/setEnable/${iid}`, { enable: body.enable }),
          'inbounds/setEnable',
        );
        done.push(body.enable ? 'включён' : 'выключен');
      }
      // выходы в Telegram за inbound-ом: выключен - как удалён, порт сменился - снимок заново,
      // включён - мог стать запасным
      const moved = body.port !== undefined && body.port !== Number(got.port);
      const off = body.enable === false && got.enable !== false;
      if (off || moved) done.push(...(await exitsAfter(id, iid, off)));
      else if (body.enable === true && got.enable === false) syncSpares();
      await journal.finish(actionId, id, 0, done.length ? done.join(', ') : 'без изменений');
      // подпись, порт и вкл/выкл видны в ссылках клиентов панели - синхронизация сразу
      if (done.length) resyncXui(db, gc, id);
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
   * Состояние 3X-UI и Xray по REST API (через агента, с токеном из "Доступов"). Только этот
   * запрос: универсальный прокси к API 3X-UI шёл мимо журнала действий. Нет токена - 409 с
   * кодом no-token (вкладка предлагает выпустить).
   */
  app.get('/api/servers/:id/xui/status', async (req, reply) => {
    const { id } = Id.parse(req.params);
    if (!registry.isOnline(id)) return reply.code(409).send({ error: 'сервер не в сети' });
    const token = savedXuiToken(db, box, id);
    if (!token)
      return reply.code(409).send({
        error: 'нет API-токена 3X-UI: его нужно выпустить на вкладке 3X-UI',
        code: 'no-token',
      });
    return unwrap(await xuiApi(registry, id, token)('GET', 'server/status'), 'server/status');
  });
}
