import type {
  ActionListRow,
  BackupInfo,
  BaselinePlan,
  BotAdmin,
  CascadesView,
  GClientDetail,
  GClientLive,
  GClientRow,
  GSyncState,
  NotifyEvents,
  PanelUpdateView,
  ServerDetail,
  ServerReach,
  ServerSummary,
  ServiceUpdate,
  Tag,
  TgHealthView,
  WatchList,
  XrayStatus,
  XuiInboundRow,
} from '@vps/protocol';
import { NotFound, type PanelApi } from './panel-api.js';
import {
  clientView,
  clientsView,
  deviceView,
  devicesView,
  liveView,
  watchesView,
} from './views/clients.js';
import type { Ctx, Screen } from './views/common.js';
import { actionView, journalView } from './views/journal.js';
import { offConfirmView, settingsView, summaryView } from './views/menu.js';
import {
  backupView,
  notifyView,
  routeView,
  sessionsView,
  syncView,
  versionView,
} from './views/panel.js';
import {
  backupsView,
  bansView,
  containerView,
  dockerView,
  logsView,
  maintenanceView,
  planView,
  reachView,
  securityView,
  serverView,
  serversView,
  tagsView,
} from './views/servers.js';
import {
  type AwgInstanceRow,
  awgUsersView,
  awgView,
  cascadesView,
  mtView,
  ofView,
  serviceButtons,
  wdttView,
  xuiView,
} from './views/services.js';

/**
 * Экраны по коду операции кнопки: данные из API панели - вид. Экран, которого нет (сервер
 * удалён), - NotFound; null - кнопка устарела (короткая ссылка пропала).
 */

export interface ScreenDeps {
  api: PanelApi;
  ctx: Ctx;
  /** значение короткой ссылки: "-" - нет значения (null), устаревшая - undefined */
  ref: (key: string | undefined) => string | null | undefined;
  admin: () => BotAdmin | null;
  version: string;
  health: () => TgHealthView;
}

type Make = (args: string[], d: ScreenDeps) => Promise<Screen | null>;

const enc = encodeURIComponent;
const server = (d: ScreenDeps, id: string | undefined) =>
  d.api.get<ServerDetail>(`/api/servers/${enc(id ?? '')}`);
const client = (d: ScreenDeps, id: string | undefined) =>
  d.api.get<GClientDetail>(`/api/gclients/${enc(id ?? '')}`);
const updatesOf = (d: ScreenDeps, id: string) =>
  d.api.get<ServiceUpdate[]>(`/api/servers/${enc(id)}/updates`).catch(() => []);
/** Новая версия панели в её канале. */
const newer = async (d: ScreenDeps) =>
  (await d.api.get<PanelUpdateView>('/api/panel/update').catch(() => null))?.newer[0]?.version ??
  null;
const found = <T>(v: T | null, what: string | undefined): T => {
  if (!v) throw new NotFound(what ?? '');
  return v;
};

/** Состояние сервиса на сервере: ответа нет (сервис не отвечает) - null, экран всё равно есть. */
const optional = <T>(d: ScreenDeps, url: string) => d.api.get<T>(url).catch(() => null);

const awg = async (args: string[], d: ScreenDeps) => {
  const s = await server(d, args[0]);
  const st = await optional<{ instances?: AwgInstanceRow[] }>(d, `/api/servers/${enc(s.id)}/awg`);
  return { s, st };
};

const SCREENS: Record<string, Make> = {
  // ---- сводка, серверы, журнал ----
  m: async (_, d) => {
    const [servers, reach, updates, clients, actions, next] = await Promise.all([
      d.api.get<ServerSummary[]>('/api/servers'),
      d.api.get<Record<string, ServerReach>>('/api/reach'),
      d.api.get<Record<string, ServiceUpdate[]>>('/api/updates'),
      d.api.get<GClientRow[]>('/api/gclients'),
      d.api.get<ActionListRow[]>('/api/actions'),
      newer(d),
    ]);
    const running = actions.filter((a) => !a.finishedAt);
    return summaryView(
      { version: d.version, newer: next, servers, reach, updates, clients, running },
      d.ctx,
    );
  },
  sl: async ([ref, page], d) => {
    const tag = d.ref(ref);
    if (tag === undefined) return null;
    const [servers, reach, tags] = await Promise.all([
      d.api.get<ServerSummary[]>('/api/servers'),
      d.api.get<Record<string, ServerReach>>('/api/reach'),
      d.api.get<Tag[]>('/api/tags'),
    ]);
    return serversView({ servers, reach, tags }, { tag, page: Number(page) || 0 }, d.ctx);
  },
  tg: async ([ref], d) => {
    const tag = d.ref(ref);
    if (tag === undefined) return null;
    const [servers, tags] = await Promise.all([
      d.api.get<ServerSummary[]>('/api/servers'),
      d.api.get<Tag[]>('/api/tags'),
    ]);
    return tagsView({ servers, tags }, tag, d.ctx);
  },
  sv: async ([id = ''], d) => {
    const [s, reach, updates] = await Promise.all([
      server(d, id),
      d.api.get<ServerReach | null>(`/api/servers/${enc(id)}/reach`),
      d.api.get<ServiceUpdate[]>(`/api/servers/${enc(id)}/updates`),
    ]);
    return serverView({ s, reach, updates, services: serviceButtons(s) }, d.ctx);
  },
  rc: async ([id = ''], d) => {
    const [s, r] = await Promise.all([
      server(d, id),
      d.api.get<ServerReach | null>(`/api/servers/${enc(id)}/reach`),
    ]);
    return reachView({ s, r }, d.ctx);
  },
  lg: async ([sid0, page], d) => {
    const sid = sid0 && sid0 !== '-' ? sid0 : null;
    const [rows, servers] = await Promise.all([
      d.api.get<ActionListRow[]>(sid ? `/api/servers/${enc(sid)}/actions` : '/api/actions'),
      d.api.get<ServerSummary[]>('/api/servers'),
    ]);
    const names = new Map(servers.map((s) => [s.id, s.name]));
    if (sid && !names.has(sid)) throw new NotFound(sid);
    return journalView({ rows, names, serverId: sid }, Number(page) || 0, d.ctx);
  },
  ac: async ([id = '', from], d) => {
    const a = await d.api.get<ActionListRow & { output: string }>(`/api/actions/${enc(id)}`);
    const servers = await d.api.get<ServerSummary[]>('/api/servers');
    const serverName = servers.find((s) => s.id === a.serverId)?.name ?? null;
    return actionView({ a, serverName, from: from === 's' ? 's' : 'g' }, d.ctx);
  },

  // ---- сервер: обслуживание, безопасность, Docker, копии ----
  mt: async ([id = ''], d) => {
    const [s, updates] = await Promise.all([
      server(d, id),
      d.api.get<ServiceUpdate[]>(`/api/servers/${enc(id)}/updates`),
    ]);
    return maintenanceView({ s, updates });
  },
  sc: async ([id], d) => securityView(await server(d, id)),
  bn: async ([id], d) => bansView(await server(d, id), d.ctx),
  pl: async ([id], d) => {
    const s = await server(d, id);
    const plan = await d.api.post<BaselinePlan>(`/api/servers/${enc(s.id)}/baseline/plan`);
    return planView(s, plan, d.ctx);
  },
  dk: async ([id], d) => dockerView(await server(d, id)),
  dc: async ([id, cid], d) => found(containerView(await server(d, id), cid ?? ''), cid),
  dl: async ([id, cid], d) => {
    const s = await server(d, id);
    const ct = found(s.inventory?.containers.find((x) => x.id === cid) ?? null, cid);
    const r = await d.api.get<{ text: string }>(
      `/api/servers/${enc(s.id)}/docker/${enc(ct.id)}/logs?tail=80`,
    );
    return logsView(s, ct, r.text ?? '');
  },
  bk: async ([id], d) => {
    const [s, list] = await Promise.all([server(d, id), d.api.get<BackupInfo[]>('/api/backups')]);
    return backupsView(s, list, d.ctx);
  },

  // ---- сервисы сервера ----
  xu: async ([id], d) => {
    const s = await server(d, id);
    const base = `/api/servers/${enc(s.id)}`;
    const [info, inbounds, updates] = await Promise.all([
      optional<{ active?: boolean; version?: string }>(d, `${base}/xui`),
      d.api.get<XuiInboundRow[]>(`${base}/xui/inbound-list`).catch(() => []),
      updatesOf(d, s.id),
    ]);
    return xuiView(s, info, inbounds, updates);
  },
  mp: async ([id], d) => {
    const s = await server(d, id);
    const [st, updates] = await Promise.all([
      optional<Parameters<typeof mtView>[1]>(d, `/api/servers/${enc(s.id)}/mtproxyl`),
      updatesOf(d, s.id),
    ]);
    return mtView(s, st, updates);
  },
  aw: async (args, d) => {
    const { s, st } = await awg(args, d);
    return awgView(s, st, d.ctx);
  },
  ai: async (args, d) => {
    const { s, st } = await awg(args, d);
    const i = Number(args[1]) || 0;
    const inst = found(st?.instances?.[i] ?? null, args[1]);
    return awgUsersView(s, inst, i, Number(args[2]) || 0, d.ctx);
  },
  wd: async ([id], d) => {
    const s = await server(d, id);
    const st = await optional<Parameters<typeof wdttView>[1]>(d, `/api/servers/${enc(s.id)}/wdtt`);
    return wdttView(s, st, d.ctx);
  },
  of: async ([id], d) => {
    const s = await server(d, id);
    return ofView(
      s,
      await optional<Parameters<typeof ofView>[1]>(d, `/api/servers/${enc(s.id)}/openflux`),
    );
  },
  cs: async ([id = ''], d) => {
    const [s, v] = await Promise.all([
      server(d, id),
      d.api.get<CascadesView>(`/api/servers/${enc(id)}/cascades`),
    ]);
    return cascadesView(s, v, d.ctx);
  },

  // ---- клиенты ----
  gl: async ([page, problems], d) =>
    clientsView(await d.api.get<GClientRow[]>('/api/gclients'), {
      page: Number(page) || 0,
      problems: problems === '1',
    }),
  gc: async ([id], d) => {
    const [g, w] = await Promise.all([client(d, id), d.api.get<WatchList>('/api/watch')]);
    return clientView(
      g,
      w.rules.filter((r) => r.clientId === g.client.id),
      d.ctx,
    );
  },
  gd: async ([id], d) => devicesView(await client(d, id)),
  gv: async ([id, did], d) => found(deviceView(await client(d, id), did ?? ''), did),
  gn: async ([id = ''], d) => {
    const g = await client(d, id);
    const live = await d.api.get<GClientLive>(`/api/gclients/${enc(id)}/live`);
    return liveView(g, live, d.ctx);
  },
  gw: async ([id], d) => {
    const [g, w] = await Promise.all([client(d, id), d.api.get<WatchList>('/api/watch')]);
    return watchesView(
      g,
      w.rules.filter((r) => r.clientId === g.client.id),
    );
  },

  // ---- управление ботом и панелью ----
  st: async (_, d) =>
    settingsView(
      { admin: d.admin(), version: d.version, newer: await newer(d), health: d.health() },
      d.ctx,
    ),
  vs: async (_, d) => versionView(await d.api.get<PanelUpdateView>('/api/panel/update'), d.ctx),
  pb: async (_, d) =>
    backupView(await d.api.get<Parameters<typeof backupView>[0]>('/api/panel-backup'), d.ctx),
  ns: async (_, d) =>
    notifyView((await d.api.get<{ events: NotifyEvents }>('/api/notify/telegram')).events),
  sy: async (_, d) => syncView(await d.api.get<GSyncState>('/api/gclients/syncing'), d.ctx),
  tr: async (_, d) => routeView(await d.api.get<XrayStatus>('/api/xray'), d.health(), d.ctx),
  ss: async (_, d) =>
    sessionsView(await d.api.get<Parameters<typeof sessionsView>[0]>('/api/security'), d.ctx),
  off: async () => offConfirmView(),
};

/** Операции кнопок, которые открывают экраны. */
export const SCREEN_OPS: ReadonlySet<string> = new Set(Object.keys(SCREENS));

/** Экран по операции кнопки; null - такой операции нет или кнопка устарела. */
export function renderScreen(op: string, args: string[], d: ScreenDeps): Promise<Screen | null> {
  const make = Object.hasOwn(SCREENS, op) ? SCREENS[op] : undefined;
  return make ? make(args, d) : Promise.resolve(null);
}
