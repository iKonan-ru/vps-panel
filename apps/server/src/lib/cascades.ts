import { createHash } from 'node:crypto';
import type {
  CascadeCheck,
  CascadeExitOption,
  CascadeMode,
  CascadeNewInfo,
  CascadeView,
  CascadesView,
} from '@vps/protocol';
import { eq, or } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { cascades, servers } from '../db/schema.js';
import type { actionJournal } from './action-journal.js';
import { busyAction } from './action-lock.js';
import {
  type ExitParams,
  RU_REALITY_CANDIDATES,
  buildOutbound,
  buildRules,
  entryInbound,
  entryRemark,
  mergeTemplate,
  outboundTag,
  ownParts,
} from './cascade-build.js';
import { type GClients, resyncXui } from './gclients.js';
import { newId } from './ids.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import {
  type XuiCall,
  type XuiFormCall,
  ensureServiceClient,
  getInbound,
  inboundNode,
  listInbounds,
  realityClientParams,
  streamOf,
  unwrap,
} from './xui-api.js';
import { watchXray, xrayState } from './xui-inbound-ops.js';
import { type Fingerprint, pickTargets, portBusy, randomFreePort } from './xui-new-inbound.js';
import { savedXuiToken, xuiFor, xuiFormFor } from './xui-token.js';

type Row = typeof cascades.$inferSelect;
type Journal = ReturnType<typeof actionJournal>;
type Say = (line: string) => void;

/** Проверка Xray после записи шаблона: изменения применяются через API ядра за секунды. */
const TEMPLATE_CHECKS_MS = [3_000, 5_000, 5_000];
/** Сверка шаблона входа с базой (порт и ключи выхода, адрес, удалённый inbound). */
const SYNC_EVERY_MS = 30 * 60_000;
/** Проверка выхода с входа. */
const CHECK_EVERY_MS = 5 * 60_000;
/** Столько неудачных проверок подряд - уведомление "каскад не работает". */
const FAILS_TO_NOTIFY = 2;

const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/** Служебный клиент каскадов входа на выходе: свой на каждый вход. */
export function cascadeClientEmail(entryServerId: string): string {
  return `vp-cascade-${createHash('sha256').update(entryServerId).digest('hex').slice(0, 10)}`;
}

/** Свой VLESS Reality RAW inbound (через него ходит каскад). */
function isRawReality(i: Record<string, unknown>): boolean {
  if (i.protocol !== 'vless' || inboundNode(i)) return false;
  const st = streamOf(i);
  const net = st.network;
  return st.security === 'reality' && (net === 'tcp' || net === 'raw' || net === undefined);
}

interface Template {
  xraySetting: Record<string, unknown>;
  outboundTestUrl: string;
}

export interface CascadeDeps {
  db: Db;
  box: SecretBox;
  registry: AgentRegistry;
  journal: Journal;
  gc: Pick<GClients, 'kick'>;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** Уведомление: каскад не работает (back=false) или снова работает. */
  notify: (entryServerId: string, text: string, back: boolean) => void;
  checksMs?: number[];
}

export interface CascadeInput {
  exitServerId: string;
  exitInboundId: number;
  port: number;
  target: string;
  serverNames: string[];
  fingerprint: Fingerprint;
  mode: CascadeMode;
  directList: string[];
  exitList: string[];
  blockQuic: boolean;
}

export type CascadeEdit = {
  [K in 'exitInboundId' | 'mode' | 'directList' | 'exitList' | 'blockQuic']?:
    | CascadeInput[K]
    | undefined;
};

/**
 * Каскады VLESS: inbound на входе, outbound к выходу и правила в шаблоне Xray 3X-UI входа.
 * Изменения на входе - действия журнала (сервер занят); шаблон пишется целиком, но меняются в
 * нём только свои части (cascade-build.ts), после записи Xray проверяется и при остановке
 * шаблон возвращается.
 */
export class Cascades {
  /** Очередь записи шаблона по входу: две записи подряд не перетирают друг друга. */
  private chains = new Map<string, Promise<unknown>>();
  /** Неудачные проверки подряд и сказали ли о них. */
  private fails = new Map<string, { count: number; notified: boolean }>();

  constructor(private d: CascadeDeps) {}

  start(): () => void {
    const a = schedule(() => void this.syncAll(), 3 * 60_000, SYNC_EVERY_MS);
    const b = schedule(() => void this.checkAll(), 2 * 60_000, CHECK_EVERY_MS);
    return () => {
      a();
      b();
    };
  }

  private rows(where?: ReturnType<typeof eq>): Row[] {
    const q = this.d.db.select().from(cascades);
    return (where ? q.where(where) : q).all();
  }

  private server(id: string) {
    const row = this.d.db.select().from(servers).where(eq(servers.id, id)).get();
    if (!row) throw fail(404, 'сервер не найден');
    return row;
  }

  private api(id: string): XuiCall {
    return xuiFor(this.d.db, this.d.box, this.d.registry, id);
  }

  private form(id: string): XuiFormCall {
    return xuiFormFor(this.d.db, this.d.box, this.d.registry, id);
  }

  private view(r: Row): CascadeView {
    const exit = this.d.db
      .select({ name: servers.name })
      .from(servers)
      .where(eq(servers.id, r.exitServerId))
      .get();
    return {
      id: r.id,
      entryServerId: r.entryServerId,
      entryInboundId: r.entryInboundId,
      entryPort: r.entryPort,
      entryRemark: r.entryRemark,
      exitServerId: r.exitServerId,
      exitServerName: exit?.name ?? '',
      exitInboundId: r.exitInboundId,
      mode: r.mode,
      directList: r.directList,
      exitList: r.exitList,
      blockQuic: r.blockQuic,
      check: r.check ?? null,
      error: r.error,
      createdAt: r.createdAt,
    };
  }

  /** Каскады входа и каскады, которые выходят через этот сервер. */
  list(serverId: string): CascadesView {
    const names = new Map(
      this.d.db
        .select({ id: servers.id, name: servers.name })
        .from(servers)
        .all()
        .map((s) => [s.id, s.name]),
    );
    return {
      cascades: this.rows(eq(cascades.entryServerId, serverId)).map((r) => this.view(r)),
      via: this.rows(eq(cascades.exitServerId, serverId)).map((r) => ({
        id: r.id,
        entryServerId: r.entryServerId,
        entryServerName: names.get(r.entryServerId) ?? '',
        exitInboundId: r.exitInboundId,
      })),
    };
  }

  /** Есть ли на сервере списки заблокированного (geosite_RU.dat и geoip_RU.dat). */
  private async geoRu(api: XuiCall): Promise<boolean> {
    try {
      const files = unwrap(await api('GET', 'xray/geodata/files'), 'xray/geodata/files') as
        | { name?: string }[]
        | null;
      const names = new Set((files ?? []).map((f) => String(f.name ?? '')));
      return names.has('geosite_RU.dat') && names.has('geoip_RU.dat');
    } catch {
      return false;
    }
  }

  /** Значения окна добавления: свободный порт входа, выходы с их RAW-inbound-ами. */
  async newInfo(entryId: string): Promise<CascadeNewInfo> {
    const { db, box, registry } = this.d;
    const entry = this.server(entryId);
    const api = this.api(entryId);
    const list = await listInbounds(api);
    const ls = entry.statusCache?.inventory?.firewall.listeners ?? [];
    const port = randomFreePort((p) => portBusy(p, list, ls) !== null);
    const others = db
      .select()
      .from(servers)
      .all()
      .filter((s) => s.id !== entryId);
    const exits = await Promise.all(
      others.map(async (s): Promise<CascadeExitOption> => {
        const base = { serverId: s.id, serverName: s.name, online: registry.isOnline(s.id) };
        if (!s.statusCache?.inventory?.services.some((x) => x.kind === 'xui'))
          return { ...base, reason: 'нет 3X-UI', inbounds: [] };
        if (!base.online) return { ...base, reason: 'сервер не в сети', inbounds: [] };
        if (!savedXuiToken(db, box, s.id))
          return { ...base, reason: 'нет API-токена 3X-UI', inbounds: [] };
        try {
          const inbounds = (await listInbounds(this.api(s.id))).filter(isRawReality).map((i) => ({
            id: Number(i.id),
            remark: String(i.remark ?? ''),
            port: Number(i.port),
            enable: i.enable !== false,
          }));
          return {
            ...base,
            reason: inbounds.length ? null : 'нет inbound VLESS Reality RAW',
            inbounds,
          };
        } catch (e) {
          return { ...base, reason: (e as Error).message, inbounds: [] };
        }
      }),
    );
    exits.sort((a, b) => Number(Boolean(a.reason)) - Number(Boolean(b.reason)));
    return {
      port,
      exits,
      geoRu: await this.geoRu(api),
      agentReady: registry.supports(entryId, 'xui.form'),
    };
  }

  /** Цели Reality входа: российские сайты, проверка - 3X-UI на самом сервере. */
  async realityScan(entryId: string) {
    const rows = unwrap(
      await this.form(entryId)('POST', 'server/scanRealityTargets', {
        targets: RU_REALITY_CANDIDATES.join(','),
      }),
      'server/scanRealityTargets',
    );
    return { targets: pickTargets(Array.isArray(rows) ? rows : []) };
  }

  /** Параметры выхода: служебный клиент на его inbound-е (заводится, если нет). */
  private async exitParams(
    entryId: string,
    exitId: string,
    inboundId: number,
  ): Promise<ExitParams> {
    const exit = this.server(exitId);
    const api = this.api(exitId);
    const inbound = await getInbound(api, inboundId);
    if (!inbound) throw fail(409, 'inbound выхода не найден в 3X-UI');
    if (!isRawReality(inbound)) throw fail(409, 'на выходе нужен inbound VLESS Reality RAW');
    if (inbound.enable === false) throw fail(409, 'inbound выхода выключен');
    const reality = realityClientParams(inbound);
    const uuid = await ensureServiceClient(api, {
      email: cascadeClientEmail(entryId),
      inboundId,
      flow: 'xtls-rprx-vision',
      comment: 'каскад VPS Panel',
    });
    return { address: exit.host, port: Number(inbound.port), uuid, ...reality };
  }

  private async readTemplate(api: XuiCall): Promise<Template> {
    const raw = unwrap(await api('POST', 'xray/'), 'xray/');
    const obj = (typeof raw === 'string' ? JSON.parse(raw) : raw) as {
      xraySetting?: unknown;
      outboundTestUrl?: string;
    };
    const x = obj?.xraySetting;
    const xraySetting = (typeof x === 'string' ? JSON.parse(x) : x) as Record<string, unknown>;
    if (!xraySetting || typeof xraySetting !== 'object')
      throw fail(502, '3X-UI не вернула шаблон Xray');
    return { xraySetting, outboundTestUrl: String(obj.outboundTestUrl ?? '') };
  }

  private async writeTemplate(form: XuiFormCall, t: Template) {
    unwrap(
      await form('POST', 'xray/update', {
        xraySetting: JSON.stringify(t.xraySetting),
        // пустой адрес 3X-UI заменит своим по умолчанию: передаём тот, что стоит
        outboundTestUrl: t.outboundTestUrl,
      }),
      'xray/update',
    );
  }

  /** Один вход - одна запись шаблона за раз. */
  private serial<T>(entryId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(entryId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.chains.set(
      entryId,
      next.catch(() => undefined),
    );
    return next;
  }

  /**
   * Шаблон входа по базе: для каждого каскада - outbound (параметры выхода с выхода; выход не в
   * сети - прежний outbound из шаблона) и правила по тегу inbound-а входа. Пропал inbound входа
   * или выхода - у каскада ошибка, его частей в шаблоне нет.
   */
  private async plan(entryId: string) {
    const { registry } = this.d;
    const api = this.api(entryId);
    const tpl = await this.readTemplate(api);
    const current = new Map(
      ((tpl.xraySetting.outbounds as Record<string, unknown>[] | undefined) ?? []).map((o) => [
        String(o.tag ?? ''),
        o,
      ]),
    );
    const inbounds = await listInbounds(api);
    const geoRu = await this.geoRu(api);
    const outbounds: Record<string, unknown>[] = [];
    const rules: Record<string, unknown>[] = [];
    const state: {
      id: string;
      label: string;
      error: string | null;
      port?: number;
      remark?: string;
    }[] = [];
    for (const r of this.rows(eq(cascades.entryServerId, entryId))) {
      const inb = inbounds.find((i) => Number(i.id) === r.entryInboundId);
      const st: (typeof state)[number] = {
        id: r.id,
        label: r.entryRemark || r.id,
        error: null,
        ...(inb ? { port: Number(inb.port), remark: String(inb.remark ?? '') } : {}),
      };
      try {
        if (!inb) throw new Error('inbound входа удалён в 3X-UI');
        const tag = String(inb.tag ?? '');
        if (!tag) throw new Error('у inbound входа нет тега');
        const ob = registry.isOnline(r.exitServerId)
          ? buildOutbound(r.id, await this.exitParams(entryId, r.exitServerId, r.exitInboundId))
          : current.get(outboundTag(r.id));
        if (!ob) throw new Error('выход не в сети');
        const own = buildRules({
          id: r.id,
          mode: r.mode,
          inboundTag: tag,
          directList: r.directList,
          exitList: r.exitList,
          blockQuic: r.blockQuic,
          geoRu,
        });
        outbounds.push(ob);
        rules.push(...own);
      } catch (e) {
        st.error = (e as Error).message;
      }
      state.push(st);
    }
    const next = { ...tpl, xraySetting: mergeTemplate(tpl.xraySetting, outbounds, rules) };
    return {
      api,
      tpl,
      next,
      state,
      changed: ownParts(next.xraySetting) !== ownParts(tpl.xraySetting),
    };
  }

  /** Состояние каскадов по плану: ошибка, порт и подпись inbound-а входа. */
  private saveState(state: Awaited<ReturnType<Cascades['plan']>>['state']) {
    for (const st of state)
      this.d.db
        .update(cascades)
        .set({
          error: st.error,
          ...(st.port !== undefined ? { entryPort: st.port, entryRemark: st.remark ?? '' } : {}),
        })
        .where(eq(cascades.id, st.id))
        .run();
  }

  /**
   * Запись шаблона входа по плану: изменилось - запись, проверка Xray, при остановке - прежний
   * шаблон. Возвращает, менялся ли шаблон.
   */
  private apply(entryId: string, say: Say): Promise<boolean> {
    return this.serial(entryId, async () => {
      const p = await this.plan(entryId);
      this.saveState(p.state);
      for (const st of p.state) if (st.error) say(`${st.label}: ${st.error}`);
      if (!p.changed) {
        say('Шаблон Xray входа уже такой');
        return false;
      }
      const form = this.form(entryId);
      const before = await xrayState(p.api).catch(() => null);
      say('Записываю шаблон Xray входа');
      await this.writeTemplate(form, p.next);
      if (before?.state === 'running') {
        const bad = await watchXray(p.api, this.d.checksMs ?? TEMPLATE_CHECKS_MS);
        if (bad) {
          await this.writeTemplate(form, p.tpl).catch(() => undefined);
          throw new Error(`Xray остановился, шаблон возвращён как был: ${bad}`);
        }
        say('Xray работает');
      }
      return true;
    });
  }

  /**
   * Новый каскад (действие на входе): служебный клиент на выходе, inbound входа (с проверкой
   * Xray), шаблон. Сбой - созданное убирается. Клиенты панели попадают в inbound синхронизацией.
   */
  create(entryId: string, body: CascadeInput): string {
    const { db, registry, journal, gc } = this.d;
    if (body.exitServerId === entryId) throw fail(400, 'выход - другой сервер');
    this.server(body.exitServerId);
    const api = this.api(entryId);
    const form = this.form(entryId);
    if (!registry.supports(entryId, 'xui.form'))
      throw fail(409, 'агент входа устарел: нужно обновить агент');
    let ok = false;
    return journal.background(
      entryId,
      'cascade:add',
      { exit: body.exitServerId, inbound: body.exitInboundId, port: body.port, mode: body.mode },
      async (action) => {
        const say = (line: string) => action.stream('log', `${line}\n`);
        const exit = this.server(body.exitServerId);
        say(`Выход ${exit.name}: служебный клиент`);
        await this.exitParams(entryId, body.exitServerId, body.exitInboundId);
        const st = await xrayState(api);
        if (st.state !== 'running')
          throw new Error(`Xray входа не работает (${st.state}): сначала нужно его запустить`);
        const ls = this.server(entryId).statusCache?.inventory?.firewall.listeners ?? [];
        const busy = portBusy(body.port, await listInbounds(api), ls);
        if (busy) throw new Error(busy);
        const remark = entryRemark(exit.name);
        say(`Inbound входа \u00ab${remark}\u00bb, порт ${body.port}`);
        const created = unwrap(
          await api(
            'POST',
            'inbounds/add',
            entryInbound({
              port: body.port,
              remark,
              target: body.target,
              serverNames: body.serverNames,
              fingerprint: body.fingerprint,
            }),
          ),
          'inbounds/add',
        ) as { id?: number } | null;
        const iid = Number(created?.id ?? 0);
        if (!iid) throw new Error('3X-UI не вернула id inbound-а');
        const bad = await watchXray(api, this.d.checksMs ?? TEMPLATE_CHECKS_MS);
        if (bad) {
          await api('POST', `inbounds/del/${iid}`).catch(() => undefined);
          throw new Error(`Xray остановился после добавления inbound-а, он удалён: ${bad}`);
        }
        const id = newId();
        db.insert(cascades)
          .values({
            id,
            entryServerId: entryId,
            entryInboundId: iid,
            entryPort: body.port,
            entryRemark: remark,
            exitServerId: body.exitServerId,
            exitInboundId: body.exitInboundId,
            mode: body.mode,
            directList: body.directList,
            exitList: body.exitList,
            blockQuic: body.blockQuic,
          })
          .run();
        try {
          await this.apply(entryId, say);
          const row = this.rows(eq(cascades.id, id))[0];
          if (row?.error) throw new Error(row.error);
        } catch (e) {
          db.delete(cascades).where(eq(cascades.id, id)).run();
          await this.apply(entryId, say).catch(() => undefined);
          await api('POST', `inbounds/del/${iid}`).catch(() => undefined);
          throw e;
        }
        ok = true;
        say('Проверка выхода');
        const check = await this.checkOne(id, form);
        say(check.ok ? `Выход отвечает, ${check.ms} мс` : `Выход не ответил: ${check.error}`);
        say('Клиенты панели добавятся синхронизацией, подписки обновятся сами');
      },
      { after: () => ok && resyncXui(db, gc, entryId) },
    );
  }

  /** Правка каскада (режим, списки, QUIC, inbound выхода) - запись шаблона входа. */
  edit(cid: string, body: CascadeEdit): string {
    const { db, journal } = this.d;
    const row = this.rows(eq(cascades.id, cid))[0];
    if (!row) throw fail(404, 'каскад не найден');
    this.api(row.entryServerId);
    const prev = { ...row };
    return journal.background(
      row.entryServerId,
      'cascade:edit',
      { cascade: cid, ...('mode' in body ? { mode: body.mode } : {}) },
      async (action) => {
        const say = (line: string) => action.stream('log', `${line}\n`);
        db.update(cascades).set(body).where(eq(cascades.id, cid)).run();
        try {
          await this.apply(row.entryServerId, say);
          const now = this.rows(eq(cascades.id, cid))[0];
          if (now?.error) throw new Error(now.error);
        } catch (e) {
          const { id: _, ...back } = prev;
          db.update(cascades).set(back).where(eq(cascades.id, cid)).run();
          await this.apply(row.entryServerId, say).catch(() => undefined);
          throw e;
        }
        say('Сохранено');
      },
    );
  }

  /** Служебный клиент входа на выходе: отвязать от inbound-а, без привязок - удалить. */
  private async releaseExitClient(entryId: string, exitId: string, inboundId: number) {
    const still = this.rows(eq(cascades.entryServerId, entryId)).some(
      (r) => r.exitServerId === exitId && r.exitInboundId === inboundId,
    );
    if (still || !this.d.registry.isOnline(exitId)) return;
    const api = this.api(exitId);
    const email = encodeURIComponent(cascadeClientEmail(entryId));
    const others = this.rows(eq(cascades.entryServerId, entryId)).some(
      (r) => r.exitServerId === exitId,
    );
    if (others) await api('POST', `clients/${email}/detach`, { inboundIds: [inboundId] });
    else await api('POST', `clients/del/${email}`);
  }

  /** Удаление каскада: части шаблона, inbound входа, служебный клиент на выходе. */
  async remove(cid: string): Promise<void> {
    const { db, journal, gc } = this.d;
    const row = this.rows(eq(cascades.id, cid))[0];
    if (!row) throw fail(404, 'каскад не найден');
    const api = this.api(row.entryServerId);
    await journal.quick(
      row.entryServerId,
      'cascade:remove',
      { cascade: cid },
      async () => {
        const notes: string[] = [];
        db.delete(cascades).where(eq(cascades.id, cid)).run();
        await this.apply(row.entryServerId, (l) => notes.push(l));
        if (row.entryInboundId) {
          await api('POST', `inbounds/del/${row.entryInboundId}`).catch(() => undefined);
          notes.push(`удалён inbound входа, порт ${row.entryPort ?? '?'}`);
        }
        await this.releaseExitClient(row.entryServerId, row.exitServerId, row.exitInboundId).catch(
          (e: Error) => notes.push(`служебный клиент на выходе не убран: ${e.message}`),
        );
        return notes;
      },
      (notes) => notes.join('\n'),
    );
    resyncXui(db, gc, row.entryServerId);
  }

  /** Проверка выхода с входа: testOutbound 3X-UI (временный Xray, запрос на адрес проверки). */
  private async checkOne(cid: string, form?: XuiFormCall): Promise<CascadeCheck> {
    const row = this.rows(eq(cascades.id, cid))[0];
    if (!row) throw fail(404, 'каскад не найден');
    let check: CascadeCheck;
    try {
      const f = form ?? this.form(row.entryServerId);
      const tpl = await this.readTemplate(this.api(row.entryServerId));
      const all = (tpl.xraySetting.outbounds as Record<string, unknown>[] | undefined) ?? [];
      const ob = all.find((o) => o.tag === outboundTag(row.id));
      if (!ob) throw new Error('outbound каскада нет в шаблоне Xray');
      const r = unwrap(
        await f('POST', 'xray/testOutbound', {
          outbound: JSON.stringify(ob),
          allOutbounds: JSON.stringify(all),
        }),
        'xray/testOutbound',
      ) as { success?: boolean; delay?: number; error?: string } | null;
      check = {
        at: new Date().toISOString(),
        ok: Boolean(r?.success),
        ms: Math.max(0, Math.round(Number(r?.delay ?? 0))),
        error: r?.success ? null : String(r?.error || 'нет ответа'),
      };
    } catch (e) {
      check = { at: new Date().toISOString(), ok: false, ms: 0, error: (e as Error).message };
    }
    this.d.db.update(cascades).set({ check }).where(eq(cascades.id, cid)).run();
    return check;
  }

  /** Проверка по кнопке. */
  check(cid: string): Promise<CascadeCheck> {
    return this.checkOne(cid);
  }

  /** Плановая проверка всех каскадов, вход которых на связи; уведомления при смене состояния. */
  async checkAll() {
    const { registry } = this.d;
    for (const r of this.rows()) {
      if (!registry.isOnline(r.entryServerId) || !registry.supports(r.entryServerId, 'xui.form'))
        continue;
      const c = await this.checkOne(r.id);
      const f = this.fails.get(r.id) ?? { count: 0, notified: false };
      const exit = this.d.db
        .select({ name: servers.name })
        .from(servers)
        .where(eq(servers.id, r.exitServerId))
        .get();
      const title = `каскад через ${exit?.name ?? 'выход'} (порт ${r.entryPort ?? '?'})`;
      if (c.ok) {
        if (f.notified) this.d.notify(r.entryServerId, `${title} снова работает`, true);
        this.fails.delete(r.id);
        continue;
      }
      f.count += 1;
      if (f.count >= FAILS_TO_NOTIFY && !f.notified) {
        f.notified = true;
        this.d.notify(r.entryServerId, `${title} не работает: ${c.error ?? ''}`, false);
      }
      this.fails.set(r.id, f);
    }
  }

  /**
   * Плановая сверка шаблонов: вход на связи и свободен; изменения - действием журнала
   * (сервер занят на время записи).
   */
  async syncAll() {
    const entries = new Set(this.rows().map((r) => r.entryServerId));
    for (const id of entries) await this.syncEntry(id).catch(() => undefined);
  }

  /** Сверка одного входа: без изменений - тихо, иначе действие с записью шаблона. */
  async syncEntry(entryId: string): Promise<void> {
    const { registry, db, journal, log } = this.d;
    if (!registry.isOnline(entryId) || !registry.supports(entryId, 'xui.form')) return;
    if (busyAction(db, entryId) || !savedXuiToken(db, this.d.box, entryId)) return;
    try {
      // сначала план без журнала: чаще всего менять нечего
      const p = await this.serial(entryId, () => this.plan(entryId));
      this.saveState(p.state);
      if (!p.changed) return;
      await journal.quick(
        entryId,
        'cascade:sync',
        {},
        async () => {
          const notes: string[] = [];
          await this.apply(entryId, (l) => notes.push(l));
          return notes;
        },
        (n) => n.join('\n'),
      );
    } catch (e) {
      log.warn({ serverId: entryId, err: (e as Error).message }, 'каскады: сверка шаблона');
    }
  }

  /**
   * Inbound изменили или удалили из панели: каскады с этим inbound-ом на входе (тег зависит от
   * порта) или на выходе (порт, ключи) - сверка их входов сразу.
   */
  afterInboundChange(serverId: string, inboundId: number) {
    const entries = new Set<string>();
    for (const r of this.rows(
      or(eq(cascades.entryServerId, serverId), eq(cascades.exitServerId, serverId)),
    ))
      if (
        (r.entryServerId === serverId && r.entryInboundId === inboundId) ||
        (r.exitServerId === serverId && r.exitInboundId === inboundId)
      )
        entries.add(r.entryServerId);
    for (const id of entries) void this.syncEntry(id);
  }

  /**
   * Сервер удалён из панели: его каскады снимаются с другой стороны (служебный клиент на выходе;
   * inbound и части шаблона на входе) и стираются. Промис - когда другая сторона обработана.
   */
  forget(serverId: string): Promise<void> {
    const { db } = this.d;
    const asEntry = this.rows(eq(cascades.entryServerId, serverId));
    const asExit = this.rows(eq(cascades.exitServerId, serverId));
    db.delete(cascades)
      .where(or(eq(cascades.entryServerId, serverId), eq(cascades.exitServerId, serverId)))
      .run();
    for (const r of [...asEntry, ...asExit]) this.fails.delete(r.id);
    const jobs: Promise<unknown>[] = asEntry.map((r) =>
      this.releaseExitClient(serverId, r.exitServerId, r.exitInboundId),
    );
    for (const id of new Set(asExit.map((r) => r.entryServerId))) {
      if (!this.d.registry.isOnline(id)) continue;
      jobs.push(
        (async () => {
          const api = this.api(id);
          for (const r of asExit.filter((x) => x.entryServerId === id))
            if (r.entryInboundId)
              await api('POST', `inbounds/del/${r.entryInboundId}`).catch(() => undefined);
          await this.syncEntry(id);
          resyncXui(db, this.d.gc, id);
        })(),
      );
    }
    return Promise.allSettled(jobs).then(() => undefined);
  }
}
