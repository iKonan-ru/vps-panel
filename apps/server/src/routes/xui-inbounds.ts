import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { servers } from '../db/schema.js';
import { actionJournal } from '../lib/action-journal.js';
import type { ServerRouteOpts } from '../lib/action-runners.js';
import { type GClients, resyncXui } from '../lib/gclients.js';
import type { RuReach } from '../lib/ru-reach.js';
import type { InboundExitHooks } from '../lib/xray-exits.js';
import { getInbound, inboundNode, listInbounds, unwrap } from '../lib/xui-api.js';
import {
  type NewItem,
  XRAY_CHECKS_MS,
  addInbounds,
  watchXray,
  xrayState,
} from '../lib/xui-inbound-ops.js';
import {
  FINGERPRINTS,
  KIND_REMARK,
  MAX_SERVER_NAMES,
  XHTTP_PORT,
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
import { xuiFor } from '../lib/xui-token.js';

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

  const apiFor = (id: string) => xuiFor(db, box, registry, id);
  const listeners = (id: string) => {
    const row = db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw Object.assign(new Error('сервер не найден'), { statusCode: 404 });
    return row.statusCache?.inventory?.firewall.listeners ?? [];
  };
  /**
   * Клиенты панели - в inbound-ы сервера сейчас, не через 5 минут. Вызывается после окончания
   * действия: пока оно идёт, сервер занят и синхронизация его пропустила бы.
   */
  const resync = (id: string) => resyncXui(db, gc, id);

  /** Значения окна: свободные порты, подписи, цели уже стоящих inbound-ов. */
  app.get('/api/servers/:id/xui/inbound-new', async (req) => {
    const { id } = Id.parse(req.params);
    const api = apiFor(id);
    const list = await listInbounds(api);
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
    const list = await listInbounds(apiFor(id));
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
    let created = false;
    const actionId = journal.background(
      id,
      'xui:inbound.add',
      {
        items: body.items,
        target: body.target,
        serverNames: names.length,
        fingerprint: body.fingerprint,
      },
      async (action) => {
        const say = (line: string) => action.stream('log', `${line}\n`);
        try {
          await addInbounds(api, {
            items: body.items as NewItem[],
            target: body.target,
            serverNames: names,
            fingerprint: body.fingerprint,
            listeners: () => listeners(id),
            say,
            checks,
          });
        } catch (e) {
          created = ((e as { created?: string[] }).created ?? []).length > 0;
          throw e;
        }
        created = true;
        // новый RAW может стать запасным выходом в Telegram этого сервера
        syncSpares();
        say('Клиенты панели добавятся синхронизацией, подписки обновятся сами');
      },
      { after: () => created && resync(id) },
    );
    return { actionId };
  });

  /** Окно правки: текущие подпись, порт, тип и Reality (без ключей), цели других inbound-ов. */
  app.get('/api/servers/:id/xui/inbounds/:iid/edit', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const list = await listInbounds(apiFor(id));
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
    let changed = false;
    const actionId = journal.background(
      id,
      'xui:inbound',
      {
        inbound: iid,
        ...(body.remark !== undefined ? { remark: body.remark } : {}),
        ...(body.port !== undefined ? { port: body.port } : {}),
        ...(body.target ? { target: body.target, serverNames: names?.length } : {}),
        ...(body.fingerprint ? { fingerprint: body.fingerprint } : {}),
      },
      async (action) => {
        const say = (line: string) => action.stream('log', `${line}\n`);
        const got = await getInbound(api, iid);
        if (!got) throw new Error('inbound не найден');
        if (inboundNode(got)) throw new Error('inbound другого узла правится на нём');
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
          const others = (await listInbounds(api)).filter((x) => Number(x.id) !== iid);
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
        say('Ссылки клиентов панели обновятся синхронизацией, подписки - сами');
        changed = true;
      },
      // подпись тоже в ссылках: синхронизация после любой правки
      { after: () => changed && resync(id) },
    );
    return { actionId };
  });

  /** Удаление inbound-а: ссылки на него уходят из подписок синхронизацией. */
  app.post('/api/servers/:id/xui/inbounds/:iid/delete', async (req) => {
    const { id, iid } = z
      .object({ id: z.string(), iid: z.coerce.number().int().positive() })
      .parse(req.params);
    const api = apiFor(id);
    await journal.quick(
      id,
      'xui:inbound.remove',
      { inbound: iid },
      async () => {
        const got = await getInbound(api, iid);
        if (!got) throw Object.assign(new Error('inbound не найден'), { statusCode: 404 });
        // на мастере группы 3X-UI удаление inbound-а узла удаляет его и на узле
        if (inboundNode(got))
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
        return [
          `удалён inbound \u00ab${String(got.remark || `#${iid}`)}\u00bb, порт ${String(got.port)}`,
          ...(await exitsAfter(id, iid, true)),
        ];
      },
      (notes) => notes.join('\n'),
    );
    resync(id);
    return { ok: true };
  });
}
