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
import { type actionJournal, onActionFinished } from './action-journal.js';
import { busyAction } from './action-lock.js';
import {
  type ExitParams,
  blockedRules,
  buildOutbound,
  buildRules,
  entryInbound,
  entryRemark,
  loopOutbound,
  mergeTemplate,
  oldEntryRemark,
  outboundTag,
  ownOf,
  ownParts,
  parseList,
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
import { XRAY_CHECKS_MS, watchXray, xrayState } from './xui-inbound-ops.js';
import {
  type Fingerprint,
  portBusy,
  randomFreePort,
  realityOf,
  withReality,
} from './xui-new-inbound.js';
import { savedXuiToken, xuiFor, xuiFormFor } from './xui-token.js';

type Row = typeof cascades.$inferSelect;
type Journal = ReturnType<typeof actionJournal>;
type Say = (line: string) => void;
type Json = Record<string, unknown>;

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

/** Ошибка выхода, после которой каскад не собрать (а не временный сбой связи или 3X-UI). */
const hard = (message: string) =>
  Object.assign(new Error(message), { statusCode: 409, hard: true });
const isHard = (e: unknown) => Boolean((e as { hard?: boolean }).hard);

/** Начало email служебных клиентов каскадов на выходах. */
const SERVICE_EMAIL_PREFIX = 'vp-cascade-';

/** Служебный клиент каскадов входа на выходе: свой на каждый вход. */
export function cascadeClientEmail(entryServerId: string): string {
  return `${SERVICE_EMAIL_PREFIX}${createHash('sha256').update(entryServerId).digest('hex').slice(0, 10)}`;
}

/** Свой VLESS Reality RAW inbound (через него ходит каскад). */
function isRawReality(i: Json): boolean {
  if (i.protocol !== 'vless' || inboundNode(i)) return false;
  const st = streamOf(i);
  const net = st.network;
  return st.security === 'reality' && (net === 'tcp' || net === 'raw' || net === undefined);
}

interface Template {
  xraySetting: Json;
  outboundTestUrl: string;
}

/** Свои части шаблона входа по базе и состояние каскадов. */
interface Plan {
  outbounds: Json[];
  rules: Json[];
  /** Inbound-ы входа с подписью прежнего вида: переименовать. */
  renames: { inboundId: number; remark: string }[];
  state: {
    id: string;
    label: string;
    error: string | null;
    port: number | null;
    remark?: string;
  }[];
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
  /** Паузы проверки Xray (тесты - короче). */
  checksMs?: number[];
  inboundChecksMs?: number[];
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
  [K in
    | 'exitInboundId'
    | 'mode'
    | 'directList'
    | 'exitList'
    | 'blockQuic'
    | 'target'
    | 'serverNames'
    | 'fingerprint']?: CascadeInput[K] | undefined;
};

/** Поля правки, которые меняют inbound входа, а не строку каскада. */
const REALITY_FIELDS = ['target', 'serverNames', 'fingerprint'] as const;

/**
 * Каскады VLESS: inbound на входе, outbound к выходу и правила в шаблоне Xray 3X-UI входа.
 * Изменения на входе - действия журнала (сервер занят); шаблон пишется целиком, но меняются в
 * нём только свои части (cascade-build.ts): шаблон перечитывается прямо перед записью, после
 * записи Xray проверяется, при остановке свои части возвращаются как были.
 */
export class Cascades {
  /** Очередь записи шаблона по входу: две записи подряд не перетирают друг друга. */
  private chains = new Map<string, Promise<unknown>>();
  /** Неудачные проверки подряд и сказали ли о них. */
  private fails = new Map<string, { count: number; notified: boolean }>();
  /** Входы, которые надо сверить, когда закончится действие на них. */
  private pending = new Set<string>();
  private checking = false;

  constructor(private d: CascadeDeps) {}

  start(): () => void {
    const a = schedule(() => void this.syncAll(), 3 * 60_000, SYNC_EVERY_MS);
    const b = schedule(() => void this.checkAll(), 2 * 60_000, CHECK_EVERY_MS);
    const c = onActionFinished((id) => {
      if (this.pending.delete(id)) void this.syncEntry(id);
    });
    return () => {
      a();
      b();
      c();
    };
  }

  private rows(where?: ReturnType<typeof eq>): Row[] {
    const q = this.d.db.select().from(cascades);
    return (where ? q.where(where) : q).all();
  }

  private row(cid: string): Row {
    const r = this.rows(eq(cascades.id, cid))[0];
    if (!r) throw fail(404, 'каскад не найден');
    return r;
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

  private requireForm(id: string) {
    if (!this.d.registry.supports(id, 'xui.form'))
      throw fail(409, 'агент входа устарел: нужно обновить агент');
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
    const files = unwrap(await api('GET', 'xray/geodata/files'), 'xray/geodata/files') as
      | { name?: string }[]
      | null;
    const names = new Set((files ?? []).map((f) => String(f.name ?? '')));
    return names.has('geosite_RU.dat') && names.has('geoip_RU.dat');
  }

  /**
   * Свои списки: строки, которые не разобрать, и категории geosite/geoip, которых нет на входе
   * (такое правило останавливает весь Xray) - ошибка 400 до записи.
   */
  private async checkLists(entryId: string, lists: (string[] | undefined)[]) {
    const all = lists.flatMap((l) => l ?? []);
    const parsed = parseList(all);
    if (parsed.invalid.length)
      throw fail(400, `не понятны строки списка: ${parsed.invalid.slice(0, 5).join(', ')}`);
    const form = this.form(entryId);
    const bad: string[] = [];
    for (const [kind, tokens] of [
      ['site', parsed.domains],
      ['ip', parsed.ips],
    ] as const) {
      if (!tokens.length) continue;
      const issues = unwrap(
        await form('POST', 'xray/geodata/validate', { tokens: tokens.join(','), kind }),
        'xray/geodata/validate',
      ) as { token?: string }[] | null;
      bad.push(...(issues ?? []).map((i) => String(i.token ?? '')));
    }
    if (bad.length) throw fail(400, `на входе нет таких категорий: ${bad.slice(0, 5).join(', ')}`);
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
      geoRu: await this.geoRu(api).catch(() => false),
      agentReady: registry.supports(entryId, 'xui.form'),
    };
  }

  /**
   * Параметры выхода: служебный клиент на его inbound-е (заводится, если нет). Inbound выхода
   * удалён, выключен или не того типа - hard: каскад не собрать; остальное - временный сбой.
   */
  private async exitParams(
    entryId: string,
    exitId: string,
    inboundId: number,
  ): Promise<ExitParams> {
    const exit = this.server(exitId);
    const api = this.api(exitId);
    // 3X-UI отвечает 200 с success=false на несуществующий id; другой код - временный сбой
    const got = await api('GET', `inbounds/get/${inboundId}`);
    const env = got.data as { success?: boolean; obj?: unknown } | undefined;
    if (got.status !== 200) throw fail(502, `3X-UI выхода не отвечает (${got.status})`);
    const inbound = env?.success ? ((env.obj as Json | null) ?? null) : null;
    if (!inbound) throw hard('inbound выхода не найден в 3X-UI');
    if (!isRawReality(inbound)) throw hard('на выходе нужен inbound VLESS Reality RAW');
    if (inbound.enable === false) throw hard('inbound выхода выключен');
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
    const xraySetting = (typeof x === 'string' ? JSON.parse(x) : x) as Json;
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
   * Свои части шаблона входа по базе. Outbound - с параметрами с выхода; выход не в сети или
   * временный сбой - прежний outbound из шаблона. Нельзя собрать (нет inbound-а выхода, нет
   * прежнего outbound-а, ошибка правил) - у каскада ошибка, его трафик - в блок, а не напрямую.
   * Пропал inbound входа - своих частей у каскада нет (3X-UI сама убрала его тег из правил).
   */
  private async plan(entryId: string, current: Template): Promise<Plan> {
    const { registry } = this.d;
    const api = this.api(entryId);
    const prevOut = new Map(
      ((current.xraySetting.outbounds as Json[] | undefined) ?? []).map((o) => [
        String(o.tag ?? ''),
        o,
      ]),
    );
    const inbounds = await listInbounds(api);
    const rows = this.rows(eq(cascades.entryServerId, entryId));
    const geoRu = rows.some((r) => r.mode !== 'all') ? await this.geoRu(api) : false;
    const plan: Plan = { outbounds: [], rules: [], renames: [], state: [] };
    for (const r of rows) {
      const inb = inbounds.find((i) => Number(i.id) === r.entryInboundId);
      const label = r.entryRemark || r.id;
      if (!inb) {
        plan.state.push({ id: r.id, label, error: 'inbound входа удалён в 3X-UI', port: null });
        continue;
      }
      const st = {
        id: r.id,
        label,
        error: null as string | null,
        port: Number(inb.port),
        remark: String(inb.remark ?? ''),
      };
      const tag = String(inb.tag ?? '');
      const renamed = oldEntryRemark(String(inb.remark ?? ''));
      if (renamed) {
        plan.renames.push({ inboundId: Number(inb.id), remark: renamed });
        st.remark = renamed;
      }
      try {
        if (!tag) throw new Error('у inbound входа нет тега');
        let ob: Json | undefined;
        if (registry.isOnline(r.exitServerId)) {
          try {
            ob = buildOutbound(
              r.id,
              await this.exitParams(entryId, r.exitServerId, r.exitInboundId),
            );
          } catch (e) {
            ob = prevOut.get(outboundTag(r.id));
            // временный сбой выхода: каскад работает со старыми параметрами, ошибки нет
            if (isHard(e) || !ob) throw e;
          }
        } else {
          ob = prevOut.get(outboundTag(r.id));
          if (!ob) throw new Error('выход не в сети');
        }
        const rules = buildRules({
          id: r.id,
          mode: r.mode,
          inboundTag: tag,
          directList: r.directList,
          exitList: r.exitList,
          blockQuic: r.blockQuic,
          geoRu,
        });
        plan.outbounds.push(ob, loopOutbound(r.id));
        plan.rules.push(...rules);
      } catch (e) {
        st.error = (e as Error).message;
        if (tag) plan.rules.push(...blockedRules(r.id, tag));
      }
      plan.state.push(st);
    }
    return plan;
  }

  /** Состояние каскадов по плану: ошибка, порт (нет inbound-а - нет порта) и подпись. */
  private saveState(state: Plan['state']) {
    for (const st of state)
      this.d.db
        .update(cascades)
        .set({
          error: st.error,
          entryPort: st.port,
          ...(st.remark !== undefined ? { entryRemark: st.remark } : {}),
        })
        .where(eq(cascades.id, st.id))
        .run();
  }

  /**
   * Запись шаблона входа: план (с запросами к выходам), шаблон перечитывается прямо перед
   * записью, свои части заменяются. Ошибка записи или остановка Xray - свои части возвращаются
   * как были на свежем шаблоне. Возвращает, менялся ли шаблон.
   */
  private apply(entryId: string, say: Say): Promise<boolean> {
    return this.serial(entryId, async () => {
      const api = this.api(entryId);
      const form = this.form(entryId);
      const plan = await this.plan(entryId, await this.readTemplate(api));
      this.saveState(plan.state);
      for (const st of plan.state) if (st.error) say(`${st.label}: ${st.error}`);
      for (const r of plan.renames) {
        const got = (await api('GET', `inbounds/get/${r.inboundId}`)).data as
          | { success?: boolean; obj?: Json }
          | undefined;
        if (got?.success && got.obj)
          unwrap(
            await api('POST', `inbounds/update/${r.inboundId}`, { ...got.obj, remark: r.remark }),
            'inbounds/update',
          );
        say(`Подпись inbound-а входа: ${r.remark}`);
      }
      const tpl = await this.readTemplate(api);
      const next = mergeTemplate(tpl.xraySetting, plan.outbounds, plan.rules);
      if (ownParts(next) === ownParts(tpl.xraySetting)) {
        say('Шаблон Xray входа уже такой');
        return false;
      }
      const before = await xrayState(api).catch(() => null);
      const old = ownOf(tpl.xraySetting);
      const restore = async () => {
        const fresh = await this.readTemplate(api).catch(() => tpl);
        await this.writeTemplate(form, {
          ...fresh,
          xraySetting: mergeTemplate(fresh.xraySetting, old.outbounds, old.rules),
        });
      };
      say('Записываю шаблон Xray входа');
      try {
        await this.writeTemplate(form, { ...tpl, xraySetting: next });
      } catch (e) {
        // 3X-UI сохраняет шаблон до перезапуска Xray: ошибка перезапуска - шаблон уже новый
        await restore().catch(() => undefined);
        throw e;
      }
      if (before?.state === 'running') {
        const bad = await watchXray(api, this.d.checksMs ?? TEMPLATE_CHECKS_MS);
        if (bad) {
          await restore().catch(() => undefined);
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
  async create(entryId: string, body: CascadeInput): Promise<string> {
    const { db, journal, gc } = this.d;
    if (body.exitServerId === entryId) throw fail(400, 'выход - другой сервер');
    this.server(body.exitServerId);
    this.requireForm(entryId);
    const api = this.api(entryId);
    const form = this.form(entryId);
    await this.checkLists(entryId, [body.directList, body.exitList]);
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
        // после inbounds/add 3X-UI перезапускает Xray не сразу: смотрим дольше, чем после шаблона
        const bad = await watchXray(api, this.d.inboundChecksMs ?? XRAY_CHECKS_MS);
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

  /**
   * Правка каскада: режим, списки, QUIC, inbound выхода - запись шаблона входа; цель Reality,
   * имена и fingerprint - правка inbound-а входа (ключи те же). После правки inbound-а панель
   * следит за Xray и при остановке возвращает inbound как был; ссылки клиентов обновятся
   * синхронизацией.
   */
  async edit(cid: string, body: CascadeEdit): Promise<string> {
    const { db, journal, gc } = this.d;
    const row = this.row(cid);
    const given = Object.fromEntries(
      Object.entries(body).filter(([, v]) => v !== undefined),
    ) as CascadeEdit;
    if (!Object.keys(given).length) throw fail(400, 'нечего менять');
    const { target, serverNames, fingerprint, ...change } = given;
    const realityGiven = REALITY_FIELDS.some((k) => given[k] !== undefined);
    if ((target === undefined) !== (serverNames === undefined))
      throw fail(400, 'цель Reality и имена меняются вместе');
    if (realityGiven && !(row.entryInboundId && row.entryPort))
      throw fail(409, 'inbound входа удалён в 3X-UI: цель Reality не поменять');
    this.requireForm(row.entryServerId);
    const api = this.api(row.entryServerId);
    await this.checkLists(row.entryServerId, [change.directList, change.exitList]);
    const rowChanged = Object.keys(change).length > 0;
    // откат - только изменённых полей: проверка и ошибка могли обновиться за время действия
    const back = Object.fromEntries(
      Object.keys(change).map((k) => [k, row[k as keyof Row]]),
    ) as CascadeEdit;
    let linksChanged = false;
    return journal.background(
      row.entryServerId,
      'cascade:edit',
      {
        cascade: cid,
        ...(change.mode ? { mode: change.mode } : {}),
        ...(target ? { target, serverNames: serverNames?.length } : {}),
        ...(fingerprint ? { fingerprint } : {}),
      },
      async (action) => {
        const say = (line: string) => action.stream('log', `${line}\n`);
        // сначала inbound входа: он может остановить Xray, шаблон после него
        let restore: (() => Promise<unknown>) | null = null;
        if (realityGiven && row.entryInboundId) {
          const iid = row.entryInboundId;
          const got = await getInbound(api, iid);
          if (!got) throw new Error('inbound входа не найден в 3X-UI');
          const cur = realityOf(got);
          const reality: { target?: string; serverNames?: string[]; fingerprint?: string } = {};
          const done: string[] = [];
          if (
            target !== undefined &&
            serverNames !== undefined &&
            (target !== cur.target || serverNames.join(',') !== cur.serverNames.join(','))
          ) {
            reality.target = target;
            reality.serverNames = serverNames;
            done.push(`цель Reality ${target}`);
          }
          if (fingerprint !== undefined && fingerprint !== cur.fingerprint) {
            reality.fingerprint = fingerprint;
            done.push(`fingerprint ${fingerprint}`);
          }
          if (done.length) {
            const before = await xrayState(api).catch(() => null);
            say(`Inbound входа: ${done.join(', ')}`);
            unwrap(
              await api('POST', `inbounds/update/${iid}`, {
                ...got,
                streamSettings: withReality(got.streamSettings, reality),
              }),
              'inbounds/update',
            );
            restore = () => api('POST', `inbounds/update/${iid}`, got).catch(() => undefined);
            if (before?.state === 'running') {
              say('Проверка Xray');
              const bad = await watchXray(api, this.d.inboundChecksMs ?? XRAY_CHECKS_MS);
              if (bad) {
                await restore();
                throw new Error(`Xray остановился после правки, inbound возвращён как был: ${bad}`);
              }
              say('Xray работает');
            }
            linksChanged = true;
          } else if (!rowChanged) {
            say('Без изменений');
            return;
          }
        }
        if (rowChanged) {
          db.update(cascades).set(change).where(eq(cascades.id, cid)).run();
          try {
            await this.apply(row.entryServerId, say);
            const now = this.rows(eq(cascades.id, cid))[0];
            if (now?.error) throw new Error(now.error);
          } catch (e) {
            db.update(cascades).set(back).where(eq(cascades.id, cid)).run();
            await this.apply(row.entryServerId, say).catch(() => undefined);
            if (restore) {
              await restore();
              linksChanged = false;
            }
            throw e;
          }
          if (change.exitInboundId !== undefined && change.exitInboundId !== row.exitInboundId)
            await this.releaseExitClient(
              row.entryServerId,
              row.exitServerId,
              row.exitInboundId,
            ).catch((e: Error) =>
              say(
                `служебный клиент на прежнем inbound-е выхода не отвязан (${e.message}): панель отвяжет его плановой сверкой`,
              ),
            );
        }
        if (linksChanged) say('Ссылки клиентов панели обновятся синхронизацией, подписки - сами');
        say('Сохранено');
      },
      { after: () => linksChanged && resyncXui(db, gc, row.entryServerId) },
    );
  }

  /**
   * Служебный клиент входа на выходе: отвязать от inbound-а, без привязок - удалить. Выход не в
   * сети - ошибка; клиента потом уберёт плановая сверка (sweepExits).
   */
  private async releaseExitClient(entryId: string, exitId: string, inboundId: number) {
    const mine = this.rows(eq(cascades.entryServerId, entryId)).filter(
      (r) => r.exitServerId === exitId,
    );
    if (mine.some((r) => r.exitInboundId === inboundId)) return;
    if (!this.d.registry.isOnline(exitId)) throw new Error('выход не в сети');
    const api = this.api(exitId);
    const email = encodeURIComponent(cascadeClientEmail(entryId));
    if (mine.length)
      unwrap(await api('POST', `clients/${email}/detach`, { inboundIds: [inboundId] }), 'detach');
    else unwrap(await api('POST', `clients/del/${email}`), 'clients/del');
  }

  /**
   * Удаление каскада: сначала свои части шаблона (не вышло - каскад остаётся как был), затем
   * inbound входа и служебный клиент на выходе.
   */
  async remove(cid: string): Promise<void> {
    const { db, journal, gc } = this.d;
    const row = this.row(cid);
    this.requireForm(row.entryServerId);
    const api = this.api(row.entryServerId);
    await journal.quick(
      row.entryServerId,
      'cascade:remove',
      { cascade: cid },
      async () => {
        const notes: string[] = [];
        db.delete(cascades).where(eq(cascades.id, cid)).run();
        try {
          await this.apply(row.entryServerId, (l) => notes.push(l));
        } catch (e) {
          db.insert(cascades).values(row).run();
          throw e;
        }
        this.fails.delete(cid);
        // нет порта - inbound входа уже удалён в 3X-UI
        if (row.entryInboundId && row.entryPort) {
          const del = await api('POST', `inbounds/del/${row.entryInboundId}`).catch(() => null);
          notes.push(
            del?.status === 200
              ? `удалён inbound входа, порт ${row.entryPort ?? '?'}`
              : 'inbound входа не удалён: удалить его можно в списке inbound-ов',
          );
        }
        await this.releaseExitClient(row.entryServerId, row.exitServerId, row.exitInboundId).catch(
          (e: Error) =>
            notes.push(
              `служебный клиент на выходе не убран (${e.message}): панель уберёт его плановой сверкой`,
            ),
        );
        return notes;
      },
      (notes) => notes.join('\n'),
    );
    resyncXui(db, gc, row.entryServerId);
  }

  /** Проверка выхода с входа: testOutbound 3X-UI (временный Xray, запрос на адрес проверки). */
  private async checkOne(cid: string, form?: XuiFormCall): Promise<CascadeCheck> {
    const row = this.row(cid);
    let check: CascadeCheck;
    try {
      const f = form ?? this.form(row.entryServerId);
      const tpl = await this.readTemplate(this.api(row.entryServerId));
      const all = (tpl.xraySetting.outbounds as Json[] | undefined) ?? [];
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

  /**
   * Плановая проверка каскадов, вход которых на связи и свободен (во время действия 3X-UI может
   * перезапускаться - ложная тревога); уведомления при смене состояния. Прогоны не накладываются.
   */
  async checkAll() {
    if (this.checking) return;
    this.checking = true;
    try {
      const { registry, db } = this.d;
      for (const r of this.rows()) {
        if (!registry.isOnline(r.entryServerId) || !registry.supports(r.entryServerId, 'xui.form'))
          continue;
        if (busyAction(db, r.entryServerId)) continue;
        const c = await this.checkOne(r.id);
        if (!this.rows(eq(cascades.id, r.id)).length) continue;
        const f = this.fails.get(r.id) ?? { count: 0, notified: false };
        const exit = db
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
    } finally {
      this.checking = false;
    }
  }

  /** Плановая сверка шаблонов всех входов. */
  async syncAll() {
    const entries = new Set(this.rows().map((r) => r.entryServerId));
    for (const id of entries) await this.syncEntry(id).catch(() => undefined);
    await this.sweepExits().catch(() => undefined);
  }

  /**
   * Служебные клиенты каскадов на выходах (vp-cascade-...) приводятся к базе: клиент без
   * каскадов удаляется, лишние inbound-ы отвязываются. Так отзываются клиенты, которых не
   * удалось убрать сразу (выход был не в сети при удалении каскада, входа или сервера).
   * Серверы - все в сети с API-токеном 3X-UI; занятые и те, чей вход сейчас занят, - в
   * следующий раз.
   */
  async sweepExits(): Promise<void> {
    const { db, registry, journal, log } = this.d;
    const all = db.select({ id: servers.id }).from(servers).all();
    // email служебного клиента -> вход (сервер в панели)
    const entryOf = new Map(all.map((x) => [cascadeClientEmail(x.id), x.id]));
    for (const { id } of all) {
      if (!registry.isOnline(id) || !savedXuiToken(db, this.d.box, id) || busyAction(db, id))
        continue;
      try {
        const api = this.api(id);
        const got = await api('GET', 'clients/list');
        // 3X-UI старше 3.1 (нет API клиентов): каскадов через такой сервер не бывает
        if (got.status === 404) continue;
        const list = (unwrap(got, 'clients/list') ?? []) as Json[];
        const work: { email: string; drop: number[] | null }[] = [];
        for (const c of list) {
          const email = String(c.email ?? '');
          if (!email.startsWith(SERVICE_EMAIL_PREFIX)) continue;
          const entry = entryOf.get(email);
          // вход занят (создание, правка, удаление каскада) - не мешать ему
          if (entry && busyAction(db, entry)) continue;
          const want = new Set(
            this.rows(eq(cascades.exitServerId, id))
              .filter((r) => r.entryServerId === entry)
              .map((r) => r.exitInboundId),
          );
          const has = ((c.inboundIds as number[] | undefined) ?? []).map(Number);
          if (!want.size) work.push({ email, drop: null });
          else {
            const extra = has.filter((x) => !want.has(x));
            if (extra.length) work.push({ email, drop: extra });
          }
        }
        if (!work.length) continue;
        await journal.quick(
          id,
          'cascade:release',
          { clients: work.length },
          async () => {
            const notes: string[] = [];
            for (const w of work) {
              const e = encodeURIComponent(w.email);
              if (w.drop)
                unwrap(await api('POST', `clients/${e}/detach`, { inboundIds: w.drop }), 'detach');
              else unwrap(await api('POST', `clients/del/${e}`), 'clients/del');
              notes.push(
                w.drop
                  ? `служебный клиент каскада ${w.email}: отвязан от inbound ${w.drop.join(', ')}`
                  : `служебный клиент каскада ${w.email}: удалён, каскадов через этот сервер у входа нет`,
              );
            }
            return notes;
          },
          (n) => n.join('\n'),
        );
      } catch (e) {
        log.warn({ serverId: id, err: (e as Error).message }, 'каскады: служебные клиенты выхода');
      }
    }
  }

  /**
   * Сверка одного входа: план без журнала (чаще всего менять нечего), отличается - действие с
   * записью шаблона. Вход занят - сверка после окончания мешающего действия.
   */
  async syncEntry(entryId: string): Promise<void> {
    const { registry, db, journal, log } = this.d;
    if (!registry.isOnline(entryId) || !registry.supports(entryId, 'xui.form')) return;
    if (!savedXuiToken(db, this.d.box, entryId)) return;
    if (busyAction(db, entryId)) {
      this.pending.add(entryId);
      return;
    }
    try {
      const changed = await this.serial(entryId, async () => {
        const api = this.api(entryId);
        const tpl = await this.readTemplate(api);
        const plan = await this.plan(entryId, tpl);
        this.saveState(plan.state);
        return (
          plan.renames.length > 0 ||
          ownParts(mergeTemplate(tpl.xraySetting, plan.outbounds, plan.rules)) !==
            ownParts(tpl.xraySetting)
        );
      });
      if (!changed) return;
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
   * порта) или на выходе (порт, ключи) - сверка их входов (вызов приходит изнутри действия,
   * поэтому сверка - по его окончании).
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

  /** Адрес сервера сменился: каскады с выходом через него - сверка их входов. */
  afterAddressChange(serverId: string) {
    for (const id of new Set(
      this.rows(eq(cascades.exitServerId, serverId)).map((r) => r.entryServerId),
    ))
      void this.syncEntry(id);
  }

  /**
   * Сервер удалён из панели: его каскады стираются и снимаются с другой стороны - служебный
   * клиент на выходе; на входе сначала свои части шаблона, потом inbound. Промис - когда другая
   * сторона обработана.
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
          await this.syncEntry(id);
          const api = this.api(id);
          for (const r of asExit.filter((x) => x.entryServerId === id))
            if (r.entryInboundId)
              await api('POST', `inbounds/del/${r.entryInboundId}`).catch(() => undefined);
          resyncXui(db, this.d.gc, id);
        })(),
      );
    }
    return Promise.allSettled(jobs).then(() => undefined);
  }
}
