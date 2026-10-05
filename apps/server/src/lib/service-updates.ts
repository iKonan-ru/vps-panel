import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import { getJsonSetting, putSetting } from './settings.js';
import { xuiToken } from './xui-token.js';

/**
 * 3X-UI, MTProxyL (менеджер) и его веб-панель. Движок telemt сюда не входит: его обновление
 * необязательно, версия меняется во вкладке MTProxyL (lib/mtproxyl-engine.ts).
 */
export type ServiceUpdateKind = 'xui' | 'mtproxyl' | 'mtproxyl-panel';

/** Обновление установленного сервиса. */
export interface ServiceUpdate {
  kind: ServiceUpdateKind;
  title: string;
  current: string;
  latest: string;
}

/**
 * Последняя проверка по серверу и сервису; notified - версия, о которой уже написали.
 * current - версия на момент проверки (у веб-панели в инвентаре версии нет), detail -
 * пояснение для вкладки, error - почему проверить не удалось.
 */
export interface Checked {
  latest: string;
  available: boolean;
  notified?: string;
  current?: string;
  detail?: string;
  error?: string;
  checkedAt?: string;
}
type Store = Record<string, Partial<Record<ServiceUpdateKind, Checked>>>;

const KEY = 'service_updates';
const EVERY_MS = 6 * 60 * 60_000;
const KINDS: ServiceUpdateKind[] = ['xui', 'mtproxyl', 'mtproxyl-panel'];
const TITLES: Record<ServiceUpdateKind, string> = {
  xui: '3X-UI',
  mtproxyl: 'MTProxyL',
  'mtproxyl-panel': 'MTProxyL: веб-панель',
};
/** Релизы веб-панели лежат в репозитории MTProxyL с этим префиксом тега. */
const PANEL_TAG = 'mtproxyl-panel-v';

/** "v3.8.5", "3.8.5" и "3.8.5-1a2b3c4" (тег образа с коммитом) - одна версия. */
const norm = (v: string) => v.trim().replace(/^v/i, '').split('-')[0] ?? '';

/** 1 - a новее b, -1 - старее, 0 - равны; null - не номера версий (сборка из ветки и т.п.). */
export function cmpVersion(a: string, b: string): number | null {
  const pa = norm(a).split('.');
  const pb = norm(b).split('.');
  if (![...pa, ...pb].every((p) => /^\d+$/.test(p))) return null;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = Number(pa[i] ?? 0) - Number(pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/**
 * Проверка обновлений раз в 6 часов через агента: 3X-UI отвечает своим API
 * getPanelUpdateInfo, MTProxyL - командой update-check, веб-панель - версией из panel status
 * и последним релизом на GitHub. Результат
 * хранится в setting, чтобы уведомление о версии не повторялось после перезапуска.
 * После обновления сервис перепроверяется сразу (recheck).
 */
export class ServiceUpdates {
  /** Проверки по очереди: расписание и кнопка не затирают общий store друг друга. */
  private queue: Promise<unknown> = Promise.resolve();
  private panelRelease: { at: number; version: string } | null = null;

  constructor(
    private db: Db,
    private box: SecretBox,
    private registry: AgentRegistry,
    private log: { warn: (o: unknown, m?: string) => void },
    /** Новая версия, о которой ещё не сообщали. */
    private onNew: (serverId: string, u: ServiceUpdate) => Promise<void>,
    /** Запрос наружу (GitHub) с хоста панели: напрямую, при сбое - через xray. */
    private fetchOut: (url: string, init?: RequestInit) => Promise<Response>,
  ) {}

  start() {
    return schedule(() => void this.checkAll(), 60_000, EVERY_MS);
  }

  /** Доступные обновления сервера; то, что уже поставлено, не показываем. */
  async list(serverId: string): Promise<ServiceUpdate[]> {
    return (await this.listAll(serverId))[serverId] ?? [];
  }

  /** То же по всем серверам (или по одному): serverId -> обновления, пустые не попадают. */
  async listAll(only?: string): Promise<Record<string, ServiceUpdate[]>> {
    const q = this.db.select({ id: servers.id, cache: servers.statusCache }).from(servers);
    const rows = only ? await q.where(eq(servers.id, only)) : await q;
    const store = await this.load();
    const res: Record<string, ServiceUpdate[]> = {};
    for (const r of rows) {
      const services = ((r.cache ?? {}) as StatusCache).inventory?.services ?? [];
      const checked = store[r.id] ?? {};
      const out: ServiceUpdate[] = [];
      for (const kind of KINDS) {
        const c = checked[kind];
        const svc = services.find((s) => s.kind === (kind === 'xui' ? 'xui' : 'mtproxyl'));
        if (!c?.available || !svc) continue;
        // у 3X-UI и MTProxyL версия из инвентаря свежее проверки: обновили - строка пропадает
        const current =
          kind === 'xui' || kind === 'mtproxyl' ? (svc.version ?? '') : (c.current ?? '');
        if (current && norm(current) === norm(c.latest)) continue;
        out.push({ kind, title: TITLES[kind], current, latest: c.latest });
      }
      if (out.length) res[r.id] = out;
    }
    return res;
  }

  /** Версии MTProxyL и панели с последней проверки - для вкладки MTProxyL. */
  async versions(serverId: string): Promise<Partial<Record<ServiceUpdateKind, Checked>>> {
    const c = (await this.load())[serverId] ?? {};
    const out: Partial<Record<ServiceUpdateKind, Checked>> = {};
    for (const k of ['mtproxyl', 'mtproxyl-panel'] as const) {
      const v = c[k];
      if (v) {
        const { notified: _, ...rest } = v;
        out[k] = rest;
      }
    }
    return out;
  }

  /** Проверить один сервер сейчас (кнопка, после обновления); итог - его обновления. */
  async recheck(serverId: string): Promise<ServiceUpdate[]> {
    await this.exclusive(async () => {
      const store = await this.load();
      await this.checkServer(serverId, store);
      await this.save(store);
    });
    return this.list(serverId);
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private checkAll() {
    return this.exclusive(async () => {
      const rows = await this.db.select({ id: servers.id }).from(servers);
      const store = await this.load();
      for (const r of rows) if (this.registry.isOnline(r.id)) await this.checkServer(r.id, store);
      await this.save(store);
    });
  }

  private async checkServer(id: string, store: Store) {
    const row = (
      await this.db
        .select({ cache: servers.statusCache })
        .from(servers)
        .where(eq(servers.id, id))
        .limit(1)
    )[0];
    const kinds = new Set(
      ((row?.cache ?? {}) as StatusCache).inventory?.services.map((s) => s.kind) ?? [],
    );
    const results: Partial<Record<ServiceUpdateKind, Checked | null>> = {};
    if (kinds.has('xui')) results.xui = await this.guard(id, 'xui', () => this.checkXui(id));
    if (kinds.has('mtproxyl')) Object.assign(results, await this.checkMtproxyl(id));
    const now = new Date().toISOString();
    for (const [k, res] of Object.entries(results) as [ServiceUpdateKind, Checked | null][]) {
      const prev = store[id]?.[k];
      if (!res) {
        // компонента нет (панель не установлена): старую запись убираем
        if (prev && store[id]) delete store[id][k];
        continue;
      }
      // сбой проверки не стирает прошлый результат: остаётся он, плюс текст ошибки
      const c: Checked =
        res.error && prev
          ? { ...prev, error: res.error, checkedAt: now }
          : { ...res, checkedAt: now };
      if (prev?.notified) c.notified = prev.notified;
      if (!res.error && c.available && c.notified !== c.latest) {
        await this.onNew(id, {
          kind: k,
          title: TITLES[k],
          current: c.current ?? '',
          latest: c.latest,
        });
        c.notified = c.latest;
      }
      store[id] = { ...store[id], [k]: c };
    }
  }

  /** Ошибка проверки не мешает остальным: пишется в журнал и в запись (для вкладки). */
  private async guard(
    id: string,
    kind: ServiceUpdateKind,
    fn: () => Promise<Checked | null>,
  ): Promise<Checked | null> {
    try {
      return await fn();
    } catch (e) {
      const error = (e as Error).message;
      this.log.warn({ serverId: id, kind, err: error }, 'service updates');
      return { latest: '', available: false, error };
    }
  }

  private async checkXui(serverId: string): Promise<Checked> {
    const token = await xuiToken(this.db, this.box, this.registry, serverId);
    const r = (await this.registry.request(
      serverId,
      'xui.api',
      { token, method: 'GET', path: 'server/getPanelUpdateInfo', body: null },
      { timeoutMs: 60_000 },
    )) as { status: number; data?: { success?: boolean; msg?: string; obj?: XuiUpdateInfo } };
    const info = r.data?.obj;
    if (r.status !== 200 || !r.data?.success || !info?.latestVersion)
      throw new Error(`3X-UI: ${r.data?.msg ?? r.status}`);
    return {
      current: info.currentVersion,
      latest: info.latestVersion,
      available: info.updateAvailable,
    };
  }

  /** Менеджер и веб-панель - из одного mtproxyl.status. */
  private async checkMtproxyl(id: string) {
    const out: Partial<Record<ServiceUpdateKind, Checked | null>> = {};
    let panel: string | null = null;
    out.mtproxyl = await this.guard(id, 'mtproxyl', async () => {
      const r = (await this.registry.request(
        id,
        'mtproxyl.status',
        {},
        { timeoutMs: 120_000 },
      )) as {
        updateCheck: {
          current: string;
          latest: string;
          update_available: boolean;
          error?: string;
        } | null;
        panel?: string;
      };
      panel = r.panel ?? '';
      const u = r.updateCheck;
      if (!u) throw new Error('mtproxyl update-check: нет ответа');
      if (u.error) throw new Error(`mtproxyl update-check: ${u.error}`);
      return { current: u.current, latest: u.latest, available: u.update_available };
    });
    // status не ответил - про панель ничего не знаем, её запись не трогаем
    if (panel === null) return out;
    // "Состояние: работает (v1.2.12)"; без версии - панель не установлена
    const panelVersion = /\((v?[0-9][^)\s]*)\)/.exec(panel)?.[1];
    out['mtproxyl-panel'] = panelVersion
      ? await this.guard(id, 'mtproxyl-panel', async () => {
          const latest = await this.latestPanel();
          return {
            current: norm(panelVersion),
            latest,
            available: cmpVersion(latest, panelVersion) === 1,
          };
        })
      : null;
    return out;
  }

  /**
   * Последний релиз веб-панели: как в её установщике (`panel update` ставит именно его) -
   * первый тег mtproxyl-panel-v* в списке релизов. Один запрос на все серверы, кэш на час.
   */
  private async latestPanel(): Promise<string> {
    if (this.panelRelease && Date.now() - this.panelRelease.at < 60 * 60_000)
      return this.panelRelease.version;
    const r = await this.fetchOut(
      'https://api.github.com/repos/Liafanx/MTProxyL/releases?per_page=100',
      { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vps-panel' } },
    );
    if (!r.ok) throw new Error(`GitHub: ${r.status}`);
    const list = (await r.json()) as { tag_name: string }[];
    const tag = list.find((x) => x.tag_name.startsWith(PANEL_TAG))?.tag_name;
    if (!tag) throw new Error('GitHub: релизов веб-панели нет');
    const version = tag.slice(PANEL_TAG.length);
    this.panelRelease = { at: Date.now(), version };
    return version;
  }

  private async load(): Promise<Store> {
    return getJsonSetting<Store>(this.db, KEY, {});
  }

  private async save(store: Store) {
    putSetting(this.db, KEY, JSON.stringify(store));
  }
}

interface XuiUpdateInfo {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
}
