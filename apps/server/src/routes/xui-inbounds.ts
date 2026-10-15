import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { StatusCache } from '../agents/state.js';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import type { ServerRouteOpts } from '../lib/action-runners.js';
import { type GClients, resyncXui } from '../lib/gclients.js';
import type { RuReach } from '../lib/ru-reach.js';
import type { InboundExitHooks } from '../lib/xray-exits.js';
import { type XuiCall, unwrap, xuiApi } from '../lib/xui-api.js';
import {
  FINGERPRINTS,
  KIND_REMARK,
  KIND_TITLE,
  MAX_SERVER_NAMES,
  type NewInboundKind,
  XHTTP_PORT,
  buildInbound,
  freeRemark,
  inboundKind,
  pickTargets,
  portBusy,
  randomFreePort,
  realityNames,
  realityOf,
  realityOfInbounds,
  withReality,
} from '../lib/xui-new-inbound.js';
import { savedXuiToken } from '../lib/xui-token.js';

const Id = z.object({ id: z.string() });
const Host = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/, 'неверное имя');
const Target = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9.-]+\.[a-z]{2,}:\d{1,5}$/, 'цель - имя:порт');
const EditBody = z
  .object({
    remark: z.string().trim().min(1).max(100).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    target: Target.optional(),
    serverNames: z.array(Host).min(1).max(MAX_SERVER_NAMES).optional(),
    fingerprint: z.enum(FINGERPRINTS).optional(),
  })
  .refine(
    (b) => (b.target === undefined) === (b.serverNames === undefined),
    'цель - вместе с именами',
  );
const AddBody = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(['raw', 'xhttp']),
        port: z.number().int().min(1).max(65535),
        remark: z.string().trim().min(1).max(100),
      }),
    )
    .min(1)
    .max(2)
    .refine((a) => new Set(a.map((x) => x.kind)).size === a.length, 'тип повторяется')
    .refine((a) => new Set(a.map((x) => x.port)).size === a.length, 'одинаковые порты'),
  target: Target,
  serverNames: z.array(Host).min(1).max(MAX_SERVER_NAMES),
  fingerprint: z.enum(FINGERPRINTS),
});

/**
 * Проверки Xray после добавления. 3X-UI отвечает успехом сразу и ещё ~10 с показывает Xray
 * работающим, а на занятом порту он падает при перезапуске, который 3X-UI делает позже (на
 * 3.10.2 - около 15 с), поэтому смотрим ~28 с.
 */
const XRAY_CHECKS_MS = [4_000, 6_000, 6_000, 6_000, 6_000];

interface Deps extends ServerRouteOpts, InboundExitHooks {
  gc: Pick<GClients, 'kick'>;
  reach: Pick<RuReach, 'dropInbound'>;
  /** Паузы проверки Xray после добавления (тесты - короче). */
  xrayChecksMs?: number[];
}

/**
 * Добавление и удаление inbound-ов VLESS с Reality (RAW и XHTTP) из вкладки 3X-UI. Клиенты
 * панели попадают в новый inbound синхронизацией (она запускается сразу), подписки обновляются
 * сами. Inbound на занятом порту останавливает весь Xray, поэтому порт проверяется по отчёту
 * агента, а после добавления Xray проверяется ~20 с: остановился - inbound удаляется.
 */
export async function xuiInboundRoutes(app: FastifyInstance, opts: Deps) {
  const { db, registry, hub, box, gc, reach, exitsAfter, syncSpares } = opts;
  const checks = opts.xrayChecksMs ?? XRAY_CHECKS_MS;
  const journal = actionJournal(db, hub, registry);

  function apiFor(id: string): XuiCall {
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
  const listeners = (id: string) => {
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    return (row.statusCache as StatusCache | null)?.inventory?.firewall.listeners ?? [];
  };
  const inboundList = async (api: XuiCall) =>
    (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<string, unknown>[]) ?? [];
  /**
   * Клиенты панели - в inbound-ы сервера сейчас, не через 5 минут. Вызывается после окончания
   * действия: пока оно идёт, сервер занят и синхронизация его пропустила бы.
   */
  const resync = (id: string) => resyncXui(db, gc, id);

  /** Значения окна: свободные порты, подписи, цели уже стоящих inbound-ов. */
  app.get('/api/servers/:id/xui/inbound-new', async (req) => {
    const { id } = Id.parse(req.params);
    const api = apiFor(id);
    const list = await inboundList(api);
    const ls = listeners(id);
    const busy = (p: number) => portBusy(p, list, ls) !== null;
    const remarks = list.map((i) => String(i.remark ?? ''));
    const xhttpBusy = portBusy(XHTTP_PORT, list, ls);
    const raw = randomFreePort(busy);
    const xhttp = xhttpBusy ? randomFreePort((p) => busy(p) || p === raw) : XHTTP_PORT;
    const same = realityOfInbounds(list);
    return {
      raw: { port: raw, remark: freeRemark(KIND_REMARK.raw, remarks) },
      xhttp: { port: xhttp, remark: freeRemark(KIND_REMARK.xhttp, remarks), note: xhttpBusy },
      same,
      fingerprint: same.find((s) => s.fingerprint)?.fingerprint ?? 'firefox',
    };
  });

  /**
   * Случайный свободный порт (кнопка у поля порта): не занят inbound-ом и процессом сервера;
   * not - порты, которые уже выбраны в окне.
   */
  app.get('/api/servers/:id/xui/free-port', async (req) => {
    const { id } = Id.parse(req.params);
    const { not } = z.object({ not: z.string().max(200).optional() }).parse(req.query);
    const skip = new Set((not ?? '').split(',').map(Number).filter(Number.isInteger));
    const list = await inboundList(apiFor(id));
    const ls = listeners(id);
    return { port: randomFreePort((p) => skip.has(p) || portBusy(p, list, ls) !== null) };
  });

  /**
   * Подбор цели Reality с самого сервера: scanRealityTargets 3X-UI по её списку кандидатов
   * (TLS 1.3, h2, X25519, сертификат, задержка); имена YouTube отбрасываются.
   */
  app.get('/api/servers/:id/xui/reality-scan', async (req) => {
    const { id } = Id.parse(req.params);
    const rows = unwrap(
      await apiFor(id)('POST', 'server/scanRealityTargets'),
      'server/scanRealityTargets',
    );
    return { targets: pickTargets(Array.isArray(rows) ? rows : []) };
  });

  /** Добавление (действие со стримом): по одному inbound-у, каждый - с проверкой Xray. */
  app.post('/api/servers/:id/xui/inbounds/new', async (req) => {
    const { id } = Id.parse(req.params);
    const body = AddBody.parse(req.body ?? {});
    const names = realityNames(body.serverNames);
    if (!names.length)
      throw Object.assign(new Error('нет подходящих имён Reality (имена YouTube не берутся)'), {
        statusCode: 400,
      });
    const api = apiFor(id);
    const action = journal.open(id, 'xui:inbound.add', {
      items: body.items,
      target: body.target,
      serverNames: names.length,
      fingerprint: body.fingerprint,
    });
    const say = (line: string) => action.stream('log', `${line}\n`);
    const created: string[] = [];
    void (async () => {
      try {
        const st = await xrayState(api);
        if (st.state !== 'running')
          throw new Error(
            `Xray не работает (${st.state}${st.error ? `: ${st.error}` : ''}): сначала нужно его запустить`,
          );
        for (const item of body.items) {
          const title = `${KIND_TITLE[item.kind]} \u00ab${item.remark}\u00bb, порт ${item.port}`;
          say(`${title}: проверка порта`);
          const list = await inboundList(api);
          const busy = portBusy(item.port, list, listeners(id));
          if (busy) throw new Error(busy);
          const inbound = buildInbound({
            kind: item.kind as NewInboundKind,
            port: item.port,
            remark: item.remark,
            target: body.target,
            serverNames: names,
            fingerprint: body.fingerprint,
          });
          const obj = unwrap(await api('POST', 'inbounds/add', inbound), 'inbounds/add') as {
            id?: number;
          } | null;
          const iid = Number(obj?.id ?? 0);
          say(`${title}: добавлен, проверка Xray`);
          const bad = await watchXray(api, checks);
          if (bad) {
            if (iid) await api('POST', `inbounds/del/${iid}`).catch(() => undefined);
            throw new Error(`Xray остановился после добавления, inbound удалён: ${bad}`);
          }
          say(`${title}: Xray работает`);
          created.push(title);
        }
        // новый RAW может стать запасным выходом в Telegram этого сервера
        syncSpares();
        say('Клиенты панели добавятся синхронизацией, подписки обновятся сами');
        await action.finish(0);
        resync(id);
      } catch (e) {
        say(`ОШИБКА: ${(e as Error).message}`);
        await action.finish(1);
        if (created.length) resync(id);
      }
    })();
    return { actionId: action.id };
  });

  /** Окно правки: текущие подпись, порт, тип и Reality (без ключей), цели других inbound-ов. */
  app.get('/api/servers/:id/xui/inbounds/:iid/edit', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const list = await inboundList(apiFor(id));
    const got = list.find((i) => Number(i.id) === iid);
    if (!got) throw Object.assign(new Error('inbound не найден'), { statusCode: 404 });
    const kind = inboundKind(got);
    return {
      id: iid,
      remark: String(got.remark ?? ''),
      port: Number(got.port ?? 0),
      kind,
      reality: kind ? realityOf(got) : null,
      same: realityOfInbounds(list).filter((x) => x.id !== iid),
    };
  });

  /**
   * Правка inbound-а (действие со стримом): подпись, порт, цель Reality и fingerprint; ключи и
   * остальное - как было. Смена порта или Reality может остановить Xray: если до правки он
   * работал, панель ~28 с следит за ним и при остановке возвращает inbound как был. Затем -
   * синхронизация клиентов (ссылки) и выходы в Telegram.
   */
  app.post('/api/servers/:id/xui/inbounds/:iid/edit', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const body = EditBody.parse(req.body ?? {});
    const names = body.serverNames ? realityNames(body.serverNames) : undefined;
    if (names && !names.length)
      throw Object.assign(new Error('нет подходящих имён Reality (имена YouTube не берутся)'), {
        statusCode: 400,
      });
    const api = apiFor(id);
    const action = journal.open(id, 'xui:inbound', {
      inbound: iid,
      ...(body.remark !== undefined ? { remark: body.remark } : {}),
      ...(body.port !== undefined ? { port: body.port } : {}),
      ...(body.target ? { target: body.target, serverNames: names?.length } : {}),
      ...(body.fingerprint ? { fingerprint: body.fingerprint } : {}),
    });
    const say = (line: string) => action.stream('log', `${line}\n`);
    void (async () => {
      try {
        const got = unwrap(await api('GET', `inbounds/get/${iid}`), 'inbounds/get') as Record<
          string,
          unknown
        > | null;
        if (!got) throw new Error('inbound не найден');
        if (Number(got.nodeId ?? got.node_id ?? 0))
          throw new Error('inbound другого узла правится на нём');
        const kind = inboundKind(got);
        const cur = kind ? realityOf(got) : null;
        const next: Record<string, unknown> = { ...got };
        const done: string[] = [];
        if (body.remark !== undefined && body.remark !== String(got.remark ?? '')) {
          next.remark = body.remark;
          done.push('подпись');
        }
        const portChanged = body.port !== undefined && body.port !== Number(got.port);
        if (portChanged && body.port !== undefined) {
          const others = (await inboundList(api)).filter((x) => Number(x.id) !== iid);
          const busy = portBusy(body.port, others, listeners(id));
          if (busy) throw new Error(busy);
          next.port = body.port;
          done.push(`порт ${String(got.port)} -> ${body.port}`);
        }
        const reality: { target?: string; serverNames?: string[]; fingerprint?: string } = {};
        if (body.target !== undefined || body.fingerprint !== undefined) {
          if (!cur) throw new Error('цель Reality и fingerprint меняются только у VLESS Reality');
          if (
            body.target !== undefined &&
            names &&
            (body.target !== cur.target || names.join(',') !== cur.serverNames.join(','))
          ) {
            reality.target = body.target;
            reality.serverNames = names;
            done.push(`цель Reality ${body.target}`);
          }
          if (body.fingerprint !== undefined && body.fingerprint !== cur.fingerprint) {
            reality.fingerprint = body.fingerprint;
            done.push(`fingerprint ${body.fingerprint}`);
          }
          if (Object.keys(reality).length)
            next.streamSettings = withReality(got.streamSettings, reality);
        }
        if (!done.length) {
          say('Без изменений');
          await action.finish(0);
          return;
        }
        const risky = portChanged || Object.keys(reality).length > 0;
        const before = risky ? await xrayState(api).catch(() => null) : null;
        say(`Сохраняю: ${done.join(', ')}`);
        unwrap(await api('POST', `inbounds/update/${iid}`, next), 'inbounds/update');
        if (risky && before?.state === 'running') {
          say('Проверка Xray');
          const bad = await watchXray(api, checks);
          if (bad) {
            await api('POST', `inbounds/update/${iid}`, got).catch(() => undefined);
            throw new Error(`Xray остановился после правки, inbound возвращён как был: ${bad}`);
          }
          say('Xray работает');
        }
        if (risky) for (const n of await exitsAfter(id, iid, false)) say(n);
        // подпись тоже в ссылках: синхронизация после любой правки
        say('Ссылки клиентов панели обновятся синхронизацией, подписки - сами');
        await action.finish(0);
        resync(id);
      } catch (e) {
        say(`ОШИБКА: ${(e as Error).message}`);
        await action.finish(1);
      }
    })();
    return { actionId: action.id };
  });

  /** Удаление inbound-а: ссылки на него уходят из подписок синхронизацией. */
  app.post('/api/servers/:id/xui/inbounds/:iid/delete', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const api = apiFor(id);
    const actionId = await journal.start(id, 'xui:inbound.remove', { inbound: iid });
    try {
      const got = unwrap(await api('GET', `inbounds/get/${iid}`), 'inbounds/get') as Record<
        string,
        unknown
      > | null;
      if (!got) throw Object.assign(new Error('inbound не найден'), { statusCode: 404 });
      // на мастере группы 3X-UI удаление inbound-а узла удаляет его и на узле
      if (Number(got.nodeId ?? got.node_id ?? 0))
        throw Object.assign(new Error('inbound другого узла удаляется на нём'), {
          statusCode: 409,
        });
      unwrap(await api('POST', `inbounds/del/${iid}`), 'inbounds/del');
      const row = db.select().from(servers).where(eq(servers.id, id)).get();
      if (row?.xuiExcluded.includes(iid))
        db.update(servers)
          .set({ xuiExcluded: row.xuiExcluded.filter((x) => x !== iid) })
          .where(eq(servers.id, id))
          .run();
      reach.dropInbound(id, iid);
      const notes = await exitsAfter(id, iid, true);
      await journal.finish(
        actionId,
        id,
        0,
        [
          `удалён inbound \u00ab${String(got.remark || `#${iid}`)}\u00bb, порт ${String(got.port)}`,
          ...notes,
        ].join('\n'),
      );
      resync(id);
      return { ok: true };
    } catch (e) {
      await journal.finish(actionId, id, 1, (e as Error).message);
      const code = (e as { statusCode?: unknown }).statusCode;
      throw Object.assign(new Error((e as Error).message), {
        statusCode: typeof code === 'number' ? code : 502,
      });
    }
  });
}

/** Состояние Xray по server/status 3X-UI. */
async function xrayState(api: XuiCall): Promise<{ state: string; error: string }> {
  const obj = unwrap(await api('GET', 'server/status'), 'server/status') as {
    xray?: { state?: string; errorMsg?: string };
  } | null;
  return { state: String(obj?.xray?.state ?? 'unknown'), error: String(obj?.xray?.errorMsg ?? '') };
}

/** Xray после добавления: несколько проверок подряд; не работает - причина, иначе null. */
async function watchXray(api: XuiCall, waits = XRAY_CHECKS_MS): Promise<string | null> {
  for (const ms of waits) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const st = await xrayState(api);
      if (st.state !== 'running') return st.error || st.state;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}
