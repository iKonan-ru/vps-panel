import { and, eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import { type StatusCache, toSummary } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { gclientBindings, gclientDevices, gclients, servers } from '../db/schema.js';
import { type actionJournal, onActionFinished } from './action-journal.js';
import { awgForgetKey } from './awg-clients.js';
import {
  type AwgStatus,
  type MtStatus,
  type NaiveStatus,
  type OfStatus,
  type ServiceDeps,
  type WdttList,
  awgEnsure,
  awgRef,
  awgRemove,
  awgStatus,
  mtEnsure,
  mtRemove,
  naiveEnsure,
  naiveRemove,
  ofChannelName,
  ofEnsure,
  ofRemove,
  wdttEnsure,
  wdttRemove,
  xuiEnsure,
  xuiLinksOutdated,
  xuiRemove,
  xuiTargets,
} from './gclient-services.js';
import { newId } from './ids.js';
import { releaseOfDocs } from './openflux-docs.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import { getJsonSetting, getSetting, putSetting } from './settings.js';
import { type WdttPassword, wdttApi } from './wdtt.js';
import { type XuiCall, ownVlessInbounds, unwrap, xuiApi } from './xui-api.js';
import { xuiToken } from './xui-token.js';

type Client = typeof gclients.$inferSelect;
type Binding = typeof gclientBindings.$inferSelect;
type ServerRow = typeof servers.$inferSelect;

type Device = typeof gclientDevices.$inferSelect;
interface ServerState {
  row: ServerRow;
  online: boolean;
  /** Галочка участия: у сервера панели - только явное включение (PANEL_HOST_KEY). */
  enabled: boolean;
  active: boolean;
  /** сервер, на котором стоит панель: клиенты на нём - только если владелец включил */
  panelHost: boolean;
  xui: boolean;
  awg: boolean;
  mtproxyl: boolean;
  wdtt: boolean;
  openflux: boolean;
  naive: boolean;
  awgInstances: { container: string; version: string; state: string }[] | null;
  /** Порты VLESS-inbound-ов 3X-UI по последнему отчёту агента (раз в 5 минут) и его время. */
  xuiPorts: { at: string; ports: number[] } | null;
}
let lastStamp = 0;

/**
 * Глобальные клиенты на сервере панели - только по явному включению владельцем (setting): у
 * сервера панели галочка участия в базе стоит по умолчанию, и без этого признака клиенты сами
 * завелись бы на нём, как только он стал бы участвовать. 80 и 443 там держит Caddy панели.
 */
export const PANEL_HOST_KEY = 'gclients_on_panel_host';

export function panelHostOptIn(db: Db): boolean {
  return getSetting(db, PANEL_HOST_KEY) === '1';
}

/**
 * Метка updatedAt привязки: время, но строго позже прошлой метки. По ней сверка узнаёт правку
 * посреди прохода; две метки в одну миллисекунду спрятали бы правку, и сверка её затёрла бы.
 */
export function stamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return new Date(lastStamp).toISOString();
}

/**
 * Поставить привязки в очередь сверки. updatedAt - метка "тронули": по ней сверка видит правку,
 * сделанную посреди её прохода, и не затирает её старыми данными.
 */
export const queued = () => ({ state: 'pending', updatedAt: stamp() });

/**
 * Привязки 3X-UI сервера - в очередь, и синхронизация сразу: inbound-ы сервера изменились
 * (добавлен, удалён, правка подписи, порта, Reality, вкл/выкл) - ссылки клиентов тоже.
 */
export function resyncXui(db: Db, gc: Pick<GClients, 'kick'>, serverId: string) {
  db.update(gclientBindings)
    .set(queued())
    .where(and(eq(gclientBindings.serverId, serverId), eq(gclientBindings.service, 'xui')))
    .run();
  gc.kick();
}

/** Клиенту разрешён сервис на сервере: доступ null - всё, иначе только отмеченное. */
export function allowed(c: Pick<Client, 'access'>, serverId: string, service: string): boolean {
  return (
    !c.access ||
    c.access.some((a) => a.serverId === serverId && (a.services as string[]).includes(service))
  );
}

/** Ошибочная привязка повторяется не чаще: иначе постоянная ошибка - запись в журнале каждые 5 минут. */
const ERROR_RETRY_MS = 30 * 60_000;

/** Сервиса нет в снимках дольше этого - он удалён, привязки убираются (снимок раз в 5 минут). */
const ABSENT_MS = 30 * 60_000;
const ABSENT_KEY = 'gclient_absent_since';
/** Ход сверки сервера: сделано из скольких, что сейчас, ошибки, последние итоги. */
export interface SyncProgress {
  done: number;
  total: number;
  current: string;
  errors: number;
  startedAt: string;
  last: string[];
  finished?: boolean;
}

interface SyncCtx {
  byId: Map<string, Client>;
  devById: Map<string, Device>;
  drop: (b: Binding) => boolean;
}

/**
 * Сверка глобальных клиентов с серверами: желаемое состояние - в базе,
 * фоновая задача приводит к нему серверы. Каждый сервер - отдельное действие в журнале
 * ("Синхронизация клиентов") с обычной блокировкой: занятый или не в сети сервер ждёт
 * следующего прохода. Раз в 5 минут и сразу после изменений (kick).
 */
export class GClients {
  private running = false;
  /** Когда экземпляры AWG сервера спрашивались у агента в последний раз (сверка). */
  private awgAsked = new Map<string, number>();
  /**
   * С какого момента сервиса нет в снимках инвентаря: "сервер:сервис" -> время. Хранится в базе
   * (ABSENT_KEY): в памяти отсчёт обнулялся бы каждым перезапуском панели (обновление,
   * восстановление), и привязки к снятому руками сервису висели бы "ok" сколько угодно.
   */
  private absentSince = new Map<string, number>();
  private absentLoaded = false;
  private again = false;
  /**
   * Серверы, пропущенные потому, что были заняты другим действием: синхронизация начинается,
   * как только оно закончится, а не через 5 минут (правка inbound-а сама её и запускает).
   */
  private waiting = new Set<string>();
  /** Ход сверки по серверам (имя сервера -> ход): для кнопок "Сверить" и панели хода. */
  readonly progress = new Map<string, SyncProgress>();
  /** Запрошена остановка: проход заканчивается после текущей операции на каждом сервере. */
  private stopRequested = false;
  /** Когда начат текущий проход (для панели хода). */
  startedAt: string | null = null;

  constructor(
    private db: Db,
    private box: SecretBox,
    private registry: AgentRegistry,
    // проход сверки - одно действие без стрима
    private journal: Pick<ReturnType<typeof actionJournal>, 'open'>,
    private panelIps: () => Promise<string[]>,
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  private loadAbsent() {
    if (this.absentLoaded) return;
    this.absentLoaded = true;
    for (const [k, v] of Object.entries(
      getJsonSetting<Record<string, number>>(this.db, ABSENT_KEY, {}),
    ))
      if (typeof v === 'number') this.absentSince.set(k, v);
  }

  private saveAbsent() {
    putSetting(this.db, ABSENT_KEY, JSON.stringify(Object.fromEntries(this.absentSince)));
  }

  private get deps(): ServiceDeps {
    return { db: this.db, box: this.box, registry: this.registry };
  }

  start() {
    const stopTimer = schedule(() => this.kick(), 30_000, 5 * 60_000);
    const stopWatch = onActionFinished((serverId) => {
      if (this.waiting.delete(serverId)) this.kick();
    });
    return () => {
      stopTimer();
      stopWatch();
    };
  }

  /**
   * Прервать сверку: каждый сервер заканчивает текущую операцию (её агент уже выполняет) и
   * останавливается; необработанные привязки остаются в очереди - их возьмёт следующая сверка
   * (по расписанию, раз в 5 минут, или кнопкой).
   */
  stop(): boolean {
    if (!this.running) return false;
    this.stopRequested = true;
    this.again = false;
    return true;
  }

  get stopping(): boolean {
    return this.stopRequested;
  }

  /** Сверка идёт сейчас: по кнопке, по расписанию или после правки клиента. */
  get syncing(): boolean {
    return this.running;
  }

  /** Запустить сверку; если она уже идёт - пройти ещё раз после неё. */
  kick() {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = true;
    this.startedAt = new Date().toISOString();
    void (async () => {
      try {
        do {
          this.again = false;
          await this.reconcile();
        } while (this.again && !this.stopRequested);
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'gclients');
      } finally {
        this.running = false;
        this.stopRequested = false;
        this.startedAt = null;
        this.progress.clear();
      }
    })();
  }

  /**
   * Все серверы: active - на нём заводятся глобальные клиенты (включён переключатель и это не
   * сервер панели), xui - агент нашёл 3X-UI, awg - контейнеры AmneziaWG, awgInstances -
   * экземпляры и их версии по последнему опросу (null - не опрашивались).
   */
  async serverStates(): Promise<ServerState[]> {
    const ips = await this.panelIps();
    const onPanel = panelHostOptIn(this.db);
    return this.db
      .select()
      .from(servers)
      .all()
      .map((row) => {
        const s = toSummary(row, this.registry, null, ips);
        const inv = (row.statusCache as StatusCache | null)?.inventory;
        const inbounds = s.services.find((x) => x.kind === 'xui')?.details?.inbounds;
        return {
          row,
          online: s.status === 'online',
          enabled: row.gclients && (!s.panelHost || onPanel),
          active: row.gclients && (!s.panelHost || onPanel),
          panelHost: s.panelHost,
          xui: s.services.some((x) => x.kind === 'xui'),
          awg: s.services.some((x) => x.kind === 'amnezia'),
          mtproxyl: s.services.some((x) => x.kind === 'mtproxyl'),
          wdtt: s.services.some((x) => x.kind === 'wdtt'),
          openflux: s.services.some((x) => x.kind === 'openflux'),
          naive: s.services.some((x) => x.kind === 'naive'),
          awgInstances: (row.statusCache as StatusCache | null)?.awgInstances ?? null,
          xuiPorts:
            inv && Array.isArray(inbounds)
              ? {
                  at: inv.collectedAt,
                  ports: (inbounds as { protocol?: string; port?: number }[])
                    .filter((i) => i.protocol === 'vless')
                    .map((i) => Number(i.port)),
                }
              : null,
        };
      });
  }

  /**
   * Итог работы по привязке. Её тронули во время прохода (выключили клиента, сменили устройства:
   * updatedAt уже другой) - созданное на сервере (пир, пароль, секрет, ссылки) записывается, но
   * привязка остаётся в очереди, и сверка сразу проходит ещё раз с новыми данными.
   */
  private setBinding(b: Binding, patch: Partial<Binding>) {
    const done = this.db
      .update(gclientBindings)
      .set({ ...patch, updatedAt: stamp() })
      .where(and(eq(gclientBindings.id, b.id), eq(gclientBindings.updatedAt, b.updatedAt)))
      .run();
    if (done.changes) return;
    const { state: _state, error: _error, ...made } = patch;
    if (Object.keys(made).length)
      this.db.update(gclientBindings).set(made).where(eq(gclientBindings.id, b.id)).run();
    this.again = true;
  }

  private addBinding(
    b: Omit<Binding, 'id' | 'secret' | 'links' | 'state' | 'error' | 'updatedAt' | 'xuiInbounds'>,
  ) {
    const row: Binding = {
      ...b,
      xuiInbounds: null,
      id: newId(),
      secret: '',
      links: [],
      state: 'pending',
      error: '',
      updatedAt: stamp(),
    };
    this.db.insert(gclientBindings).values(row).run();
    return row;
  }

  async reconcile() {
    const clients = this.db.select().from(gclients).all();
    const devices = this.db.select().from(gclientDevices).all();
    const states = await this.serverStates();
    const bindings = this.db.select().from(gclientBindings).all();
    const live = clients.filter((x) => !x.deletedAt);
    const liveDevices = devices.filter(
      (d) => !d.deletedAt && live.some((c) => c.id === d.clientId),
    );
    const has = (b: Partial<Binding>) =>
      bindings.some(
        (x) =>
          x.clientId === b.clientId &&
          x.serverId === b.serverId &&
          x.service === b.service &&
          x.deviceId === (b.deviceId ?? null) &&
          (b.service !== 'awg' || awgRef(x.ref).major === awgRef(b.ref ?? '').major),
      );

    for (const t of states.filter((x) => x.active)) {
      // VLESS: человек x сервер с 3X-UI
      if (t.xui)
        for (const c of live.filter((x) => allowed(x, t.row.id, 'xui'))) {
          const want = {
            clientId: c.id,
            deviceId: null,
            serverId: t.row.id,
            service: 'xui',
            ref: c.slug,
          };
          if (!has(want)) bindings.push(this.addBinding(want));
        }
      // MTProxy: человек x сервер с MTProxyL
      if (t.mtproxyl)
        for (const c of live.filter((x) => allowed(x, t.row.id, 'mtproxyl'))) {
          const want = {
            clientId: c.id,
            deviceId: null,
            serverId: t.row.id,
            service: 'mtproxyl',
            ref: c.slug,
          };
          if (!has(want)) bindings.push(this.addBinding(want));
        }
      // WDTT: человек x сервер с WDTT - пароль на несколько устройств
      if (t.wdtt)
        for (const c of live.filter((x) => allowed(x, t.row.id, 'wdtt'))) {
          const want = {
            clientId: c.id,
            deviceId: null,
            serverId: t.row.id,
            service: 'wdtt',
            ref: c.slug,
          };
          if (!has(want)) bindings.push(this.addBinding(want));
        }
      // Прокси для браузера: человек x сервер с naive
      if (t.naive)
        for (const c of live.filter((x) => allowed(x, t.row.id, 'naive'))) {
          const want = {
            clientId: c.id,
            deviceId: null,
            serverId: t.row.id,
            service: 'naive',
            ref: c.slug,
          };
          if (!has(want)) bindings.push(this.addBinding(want));
        }
      // AWG: устройство x сервер с контейнерами AWG; экземпляр 3.x всегда, 2.0 - по галочке, но
      // только если экземпляр этой версии на сервере есть (нет - и не заводим, без ошибок).
      // Экземпляры - не старше 30 минут: поставили новый - клиенты на него попадут
      const asked = this.awgAsked.get(t.row.id) ?? 0;
      const awgDevices = liveDevices.filter((d) => {
        const c = live.find((x) => x.id === d.clientId);
        return c !== undefined && allowed(c, t.row.id, 'awg');
      });
      if (t.awg && awgDevices.length) {
        if ((!t.awgInstances || Date.now() - asked > 30 * 60_000) && t.online)
          try {
            this.awgAsked.set(t.row.id, Date.now());
            t.awgInstances =
              (await awgStatus(this.deps, t.row.id)).instances?.map((i) => ({
                container: i.container,
                version: i.version ?? '',
                state: i.state ?? '',
              })) ?? [];
          } catch {
            // агент не ответил - в следующий раз
          }
        const hasMajor = (major: string) =>
          (t.awgInstances ?? []).some((i) => i.version.startsWith(major));
        for (const d of awgDevices)
          for (const major of d.awg20 ? ['3', '2'] : ['3']) {
            if (!hasMajor(major)) continue;
            const want = {
              clientId: d.clientId,
              deviceId: d.id,
              serverId: t.row.id,
              service: 'awg',
              ref: `${major}||`,
            };
            if (!has(want)) bindings.push(this.addBinding(want));
          }
      }
      // OpenFlux: устройство x сервер с OpenFlux - канал на устройство; у роутеров
      // приложения OpenFlux нет
      if (t.openflux)
        for (const d of liveDevices) {
          const c = live.find((x) => x.id === d.clientId);
          if (!c || d.type === 'router' || !allowed(c, t.row.id, 'openflux')) continue;
          const want = {
            clientId: c.id,
            deviceId: d.id,
            serverId: t.row.id,
            service: 'openflux',
            ref: ofChannelName(d.id),
          };
          if (!has(want)) bindings.push(this.addBinding(want));
        }
    }

    const byId = new Map(clients.map((c) => [c.id, c]));
    const devById = new Map(devices.map((d) => [d.id, d]));
    const stale = (b: Binding) => Date.now() - Date.parse(b.updatedAt) > 6 * 60 * 60_000;
    // серверы - параллельно: каждый со своим агентом, долгая работа на одном (каналы OpenFlux)
    // не держит остальные
    this.loadAbsent();
    const perServer = async (t: (typeof states)[number]) => {
      let mine = bindings.filter((b) => b.serverId === t.row.id);
      if (!mine.length) return;
      // Сервис с сервера удалили: убирать на сервере нечего, привязки - из базы. Но только если
      // его нет в снимках дольше ABSENT_MS: на один снимок он пропадает и при перезапуске docker
      // или переустановке, а стёртая привязка оставила бы на сервере пир или пароль, который
      // панель уже не отзовёт. Пока сервиса нет, его привязки не трогаются.
      for (const [service, present] of [
        ['xui', t.xui],
        ['awg', t.awg],
        ['mtproxyl', t.mtproxyl],
        ['wdtt', t.wdtt],
        ['openflux', t.openflux],
        ['naive', t.naive],
      ] as const) {
        const key = `${t.row.id}:${service}`;
        if (present || !t.online) {
          if (present && this.absentSince.delete(key)) this.saveAbsent();
          continue;
        }
        const since = this.absentSince.get(key) ?? Date.now();
        if (!this.absentSince.has(key)) {
          this.absentSince.set(key, since);
          this.saveAbsent();
        }
        if (Date.now() - since < ABSENT_MS) continue;
        for (const b of mine.filter((x) => x.service === service))
          this.db.delete(gclientBindings).where(eq(gclientBindings.id, b.id)).run();
      }
      const present: Record<string, boolean> = {
        xui: t.xui,
        awg: t.awg,
        mtproxyl: t.mtproxyl,
        wdtt: t.wdtt,
        openflux: t.openflux,
        naive: t.naive,
      };
      mine = mine.filter((b) => present[b.service] !== false || !t.online);
      // сервер исключили, клиента или устройство удалили, сняли доступ к сервису на сервере или
      // галочку AWG 2.0 - убрать
      const drop = (b: Binding) => {
        const c = byId.get(b.clientId);
        if (!t.active || !c || c.deletedAt || !allowed(c, b.serverId, b.service)) return true;
        if (!b.deviceId) return false;
        const d = devById.get(b.deviceId);
        return (
          !d ||
          Boolean(d.deletedAt) ||
          (b.service === 'awg' && awgRef(b.ref).major === '2' && !d.awg20) ||
          (b.service === 'openflux' && d.type === 'router')
        );
      };
      // "Сверить сейчас" и любая правка ставят ошибочные привязки в очередь - повтор сразу
      const retry = (b: Binding) =>
        b.state === 'pending' ||
        (b.state === 'error' && Date.now() - Date.parse(b.updatedAt) > ERROR_RETRY_MS);
      const work = mine.filter(
        (b) =>
          retry(b) ||
          drop(b) ||
          (b.service === 'xui' && (stale(b) || xuiLinksOutdated(b, t.xuiPorts))) ||
          // срок пароля WDTT продлевается сверкой, пропавший на сервере - заводится заново
          (b.service === 'wdtt' && stale(b)) ||
          // пользователь прокси пропал (переустановка) или сменились имя и порты - заново
          (b.service === 'naive' && stale(b)) ||
          // канал удалили руками (или вместе с OpenFlux) - заводится заново
          (b.service === 'openflux' &&
            (stale(b) ||
              (b.error !== '' && Date.now() - Date.parse(b.updatedAt) > ERROR_RETRY_MS))),
      );
      if (!work.length || !t.online) return;
      await this.syncServer(t.row, work, { byId, devById, drop });
    };
    await Promise.all(states.map((t) => perServer(t)));

    // удалённые клиенты и устройства без привязок - стереть
    const left = this.db.select().from(gclientBindings).all();
    for (const c of clients.filter((x) => x.deletedAt))
      if (!left.some((b) => b.clientId === c.id))
        this.db.delete(gclients).where(eq(gclients.id, c.id)).run();
    for (const d of devices.filter((x) => x.deletedAt))
      if (!left.some((b) => b.deviceId === d.id))
        this.db.delete(gclientDevices).where(eq(gclientDevices.id, d.id)).run();
  }

  /** Одно действие в журнале на сервер: изменения 3X-UI и AWG по порядку. */
  private async syncServer(row: ServerRow, work: Binding[], ctx: SyncCtx) {
    let action: ReturnType<ReturnType<typeof actionJournal>['open']>;
    try {
      action = this.journal.open(row.id, 'gclients.sync', { count: work.length });
    } catch {
      // сервер занят другим действием - сразу после его окончания
      this.waiting.add(row.id);
      return;
    }
    const out: string[] = [];
    let failed = 0;
    // cups.online ограничил частоту на этом проходе: следующие каналы - без комнат (сразу, без
    // минутных повторов на каждый), комнаты добавит повтор через ERROR_RETRY_MS
    const ofPass = { cupsOff: false };
    const prog: SyncProgress = {
      done: 0,
      total: work.length,
      current: '',
      errors: 0,
      startedAt: new Date().toISOString(),
      last: [],
    };
    this.progress.set(row.name, prog);
    // итог строки - сразу в вывод действия (консоль на странице сервера), в журнал и в ход
    // синхронизации (последние пять)
    const say = (line: string) => {
      out.push(line);
      action.stream('log', `${line}\n`);
      prog.last.push(line);
      if (prog.last.length > 5) prog.last.shift();
    };
    say(`Синхронизация клиентов: изменений ${work.length}`);
    // Состояние сервисов спрашивается один раз и только если есть работа для них. Запоминается
    // и ошибка: после таймаута следующие привязки не ждут те же 60-120 с заново.
    let xui: Promise<{ api: XuiCall; target: number[]; reason: string; own: number[] }> | null =
      null;
    let awg: Promise<AwgStatus> | null = null;
    let mt: Promise<MtStatus> | null = null;
    let wd: Promise<WdttList> | null = null;
    let of: Promise<OfStatus> | null = null;
    let nv: Promise<NaiveStatus> | null = null;
    const xuiCtx = () => {
      xui ??= (async () => {
        const api = xuiApi(
          this.registry,
          row.id,
          await xuiToken(this.db, this.box, this.registry, row.id),
        );
        const list = unwrap(await api('GET', 'inbounds/list'), 'inbounds/list');
        const inbounds = (list as Record<string, unknown>[] | null) ?? [];
        const own = ownVlessInbounds(inbounds).map((i) => Number(i.id));
        return { api, own, ...xuiTargets(inbounds, row.xuiExcluded) };
      })();
      return xui;
    };
    const awgCtx = () => {
      awg ??= awgStatus(this.deps, row.id);
      return awg;
    };
    const wdCtx = () => {
      wd ??= wdttApi(this.registry, row.id, 'GET', '/admin/passwords').then((r) => ({
        passwords: (r.data as { passwords?: WdttPassword[] }).passwords ?? [],
        dtlsPort: r.dtlsPort,
        wgPort: r.wgPort,
      }));
      return wd;
    };
    const ofCtx = () => {
      of ??= this.registry.request<OfStatus>(row.id, 'openflux.status', {}, { timeoutMs: 60_000 });
      return of;
    };
    const nvCtx = () => {
      nv ??= this.registry.request<NaiveStatus>(row.id, 'naive.status', {}, { timeoutMs: 60_000 });
      return nv;
    };
    const mtCtx = () => {
      mt ??= this.registry.request<MtStatus>(row.id, 'mtproxyl.status', {}, { timeoutMs: 120_000 });
      return mt;
    };
    let stoppedAt: number | null = null;
    for (const [i, b] of work.entries()) {
      prog.done = i;
      if (this.stopRequested) {
        say(`синхронизация прервана: осталось ${work.length - i} - в следующий раз`);
        stoppedAt = i;
        break;
      }
      const c = ctx.byId.get(b.clientId);
      const dev = b.deviceId ? ctx.devById.get(b.deviceId) : undefined;
      const label =
        b.service === 'awg'
          ? `AWG ${awgRef(b.ref).major}.x ${c?.name ?? ''}`
          : b.service === 'openflux'
            ? `OpenFlux ${c?.name ?? ''} (${dev?.name ?? ''}) ${b.ref}`
            : `${b.service} ${b.ref}`;
      prog.current = label;
      try {
        if (!c || ctx.drop(b)) {
          if (b.service === 'xui') await xuiRemove((await xuiCtx()).api, b.ref);
          if (b.service === 'awg') await awgRemove(this.deps, row.id, b.ref);
          if (b.service === 'mtproxyl') await mtRemove(this.deps, row.id, b.ref);
          if (b.service === 'wdtt') await wdttRemove(this.deps, row.id, b);
          if (b.service === 'naive') await naiveRemove(this.deps, row.id, b.ref);
          if (b.service === 'openflux') {
            await ofRemove(this.deps, row.id, b.ref);
            releaseOfDocs(this.db, b.id);
          }
          this.db.delete(gclientBindings).where(eq(gclientBindings.id, b.id)).run();
          say(`${label}: удалён`);
          continue;
        }
        if (b.service === 'xui') {
          const x = await xuiCtx();
          // свой набор (вкладка 3X-UI) - из тех inbound-ов, что ещё есть
          const target = b.xuiInbounds
            ? b.xuiInbounds.filter((id) => x.own.includes(id))
            : x.target;
          if (!target.length) {
            // своих inbound-ов VLESS на сервере нет (удалили все): VLESS здесь просто нет -
            // не ошибка; ссылок нет, сервер уходит из подписки
            if (!x.own.length && !b.xuiInbounds) {
              this.setBinding(b, { state: 'ok', error: '', links: [] });
              say(`${label}: своих inbound VLESS нет, ссылки убраны`);
              continue;
            }
            // остальное - ошибка, но и тогда старые ссылки (на удалённые, выключенные или
            // исключённые inbound-ы) из подписки уходят
            throw Object.assign(
              new Error(
                b.xuiInbounds
                  ? 'inbound из набора клиента больше нет в 3X-UI: набор нужно задать заново на вкладке 3X-UI'
                  : x.reason,
              ),
              { clearLinks: true },
            );
          }
          const links = await xuiEnsure(x.api, c, b.ref, target);
          this.setBinding(b, { state: 'ok', error: '', links });
          say(`${label}: ${c.enabled ? 'включён' : 'выключен'}, inbound: ${target.length}`);
        }
        if (b.service === 'mtproxyl') {
          const r = await mtEnsure(this.deps, row.id, await mtCtx(), c, b);
          this.setBinding(b, { state: 'ok', error: '', ...r });
          say(`${label}: ${c.enabled ? 'включён' : 'выключен'}`);
        }
        if (b.service === 'wdtt') {
          // устройств на пароль - по числу устройств человека, кроме роутеров
          const devices = [...ctx.devById.values()].filter(
            (d) => d.clientId === c.id && !d.deletedAt && d.type !== 'router',
          ).length;
          const r = await wdttEnsure(this.deps, row, await wdCtx(), c, b, Math.max(1, devices));
          this.setBinding(b, { state: 'ok', error: '', ...r });
          say(
            `${label}: ${c.enabled ? 'включён' : 'выключен'}, устройств до ${Math.max(1, devices)}`,
          );
        }
        if (b.service === 'naive') {
          const r = await naiveEnsure(this.deps, row, await nvCtx(), c, b);
          this.setBinding(b, { state: 'ok', error: '', ...r });
          say(`${label}: ${c.enabled ? 'включён' : 'выключен'}`);
        }
        if (b.service === 'openflux') {
          if (!dev) throw new Error('устройство не найдено');
          const { warning, ...r } = await ofEnsure(this.deps, row, await ofCtx(), c, b, ofPass);
          // канал работает и без комнат cups.online: привязка в порядке, причина - в error,
          // повтор - не раньше ERROR_RETRY_MS (cups.online ограничивает частоту)
          this.setBinding(b, { state: 'ok', error: warning, ...r });
          say(`${label}: ${c.enabled ? 'включён' : 'выключен'}${warning ? ` (${warning})` : ''}`);
        }
        if (b.service === 'awg') {
          const d = b.deviceId ? ctx.devById.get(b.deviceId) : undefined;
          if (!d) throw new Error('устройство не найдено');
          // Экземпляра этой версии на сервере нет (по свежему опросу) - привязку убираем, не
          // ошибка. Только если docker ответил: иначе пустой список - сбой опроса, а забытый ключ
          // не восстановить.
          const st = await awgCtx();
          const { major, container, publicKey } = awgRef(b.ref);
          if (!st.instances?.some((i) => (i.version ?? '').startsWith(major))) {
            if (!st.docker) throw new Error('docker на сервере не ответил, повтор позже');
            if (container && publicKey) await awgForgetKey(this.db, row.id, container, publicKey);
            this.db.delete(gclientBindings).where(eq(gclientBindings.id, b.id)).run();
            say(`${label}: экземпляра AWG ${major}.x на сервере нет, привязка убрана`);
            continue;
          }
          const ref = await awgEnsure(this.deps, row.id, st, c, d, b.ref);
          this.setBinding(b, { state: 'ok', error: '', ref });
          say(`${label}: ${awgRef(ref).container}, ${c.enabled ? 'включён' : 'выключен'}`);
        }
      } catch (e) {
        failed++;
        prog.errors++;
        const error = (e as Error).message;
        const clear = (e as { clearLinks?: boolean }).clearLinks === true;
        this.setBinding(b, { state: 'error', error, ...(clear ? { links: [] } : {}) });
        say(`${label}: ошибка: ${error}`);
        // агент завис или отключился: остальное по серверу - в следующий проход, а не каждая
        // привязка со своим таймаутом
        if (/^(агент (не ответил вовремя|отключился)|сервер не в сети)/i.test(error)) {
          say('агент не отвечает - остальное в следующий раз');
          stoppedAt = i + 1;
          break;
        }
      }
    }
    // сервер готов: в ходе сверки остаётся до конца прохода (с итогом)
    prog.done = stoppedAt ?? work.length;
    prog.current = '';
    prog.finished = true;
    await action.finish(failed ? 1 : 0, out.join('\n'));
  }
}
