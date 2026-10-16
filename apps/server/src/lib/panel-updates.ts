import { existsSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Db } from '../db/index.js';
import { githubReleases } from './github.js';
import { schedule } from './schedule.js';
import { getJsonSetting, getSetting, putSetting } from './settings.js';
import { PANEL_VERSION } from './version.js';

export const PANEL_REPO = 'iKonan-ru/vps-panel';
const CACHE_KEY = 'panel_releases';
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/;

export type PanelChannel = 'stable' | 'beta';

export interface PanelRelease {
  version: string;
  prerelease: boolean;
  notes: string;
  url: string;
  publishedAt: string;
}

export interface PanelUpdateSettings {
  channel: PanelChannel;
  /** Ставить новую версию канала самой, в час autoHour (UTC). */
  autoUpdate: boolean;
  autoHour: number;
  /** После обновления панели раскатить агентов (по одному). */
  agentsAuto: boolean;
}

export interface PanelUpdateView extends PanelUpdateSettings {
  current: string;
  /** Установка из релиза (vps-panel): есть data/update - панель может обновиться сама. */
  managed: boolean;
  /** Новее текущей в своём канале, от новой к старой (со списком изменений). */
  newer: PanelRelease[];
  checkedAt: string | null;
  error: string | null;
  /** Запрос обновления передан службе на хосте, ещё не подхвачен. */
  requested: string | null;
}

/** Сравнение версий semver (X.Y.Z и X.Y.Z-beta.N): >0 - a новее. Не версия - меньше любой. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a);
  const pb = SEMVER.exec(b);
  if (!pa || !pb) return pa ? 1 : pb ? -1 : 0;
  const key = (m: RegExpExecArray) => [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] === undefined ? 1 : 0,
    Number(m[4] ?? 0),
  ];
  const ka = key(pa);
  const kb = key(pb);
  for (let i = 0; i < ka.length; i++) if (ka[i] !== kb[i]) return (ka[i] ?? 0) - (kb[i] ?? 0);
  return 0;
}

export const isVersion = (v: string) => SEMVER.test(v);

/**
 * Новые версии панели: релизы GitHub раз в 6 часов (напрямую, при сбое - через xray), блок
 * "Версия панели" в Настройках, уведомление о новой версии, обновление по кнопке или само в
 * заданный час. Ставит обновление служба на хосте (vps-panel serve-request): панель только
 * пишет data/update/request.json - прав на docker у контейнера нет.
 */
export class PanelUpdates {
  private requested: string | null = null;

  constructor(
    private db: Db,
    private dataDir: string,
    private fetchOut: (url: string, init?: RequestInit) => Promise<Response>,
    private log: { warn: (o: unknown, m?: string) => void },
    /** Новая версия в канале - уведомление (один раз на версию). */
    private onNew: (r: PanelRelease) => Promise<void>,
    readonly current = PANEL_VERSION,
    /** Канал установки (PANEL_CHANNEL из .env, install --beta): пока владелец не выбрал свой. */
    private defaultChannel: PanelChannel = 'stable',
  ) {}

  get managed(): boolean {
    return isVersion(this.current) && existsSync(join(this.dataDir, 'update'));
  }

  start() {
    const stopCheck = schedule(() => void this.refresh(), 3 * 60_000, 6 * 60 * 60_000);
    // автообновление: раз в 10 минут проверка часа
    const stopAuto = schedule(() => void this.auto(), 5 * 60_000, 10 * 60_000);
    return () => {
      stopCheck();
      stopAuto();
    };
  }

  settings(): PanelUpdateSettings {
    const s = getJsonSetting<Partial<PanelUpdateSettings>>(this.db, 'panel_update', {});
    const hour = Number(s.autoHour);
    return {
      channel: s.channel === 'beta' || s.channel === 'stable' ? s.channel : this.defaultChannel,
      autoUpdate: s.autoUpdate === true,
      autoHour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 2,
      agentsAuto: s.agentsAuto !== false,
    };
  }

  saveSettings(patch: { [K in keyof PanelUpdateSettings]?: PanelUpdateSettings[K] | undefined }) {
    const next = { ...this.settings() };
    for (const [k, v] of Object.entries(patch))
      if (v !== undefined) Object.assign(next, { [k]: v });
    putSetting(this.db, 'panel_update', JSON.stringify(next));
  }

  private cache() {
    return getJsonSetting<{
      releases: PanelRelease[];
      checkedAt: string | null;
      error: string | null;
    }>(this.db, CACHE_KEY, { releases: [], checkedAt: null, error: null });
  }

  /** Версии новее текущей в канале, от новой к старой. */
  newer(): PanelRelease[] {
    const beta = this.settings().channel === 'beta';
    return this.cache()
      .releases.filter(
        (r) => (beta || !r.prerelease) && compareVersions(r.version, this.current) > 0,
      )
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  view(): PanelUpdateView {
    const c = this.cache();
    return {
      ...this.settings(),
      current: this.current,
      managed: this.managed,
      newer: this.newer(),
      checkedAt: c.checkedAt,
      error: c.error,
      requested: this.requested && existsSync(this.requestFile()) ? this.requested : null,
    };
  }

  async refresh(): Promise<void> {
    const c = this.cache();
    try {
      const list = await githubReleases(this.fetchOut, PANEL_REPO, 100);
      c.releases = list
        .map((x) => ({
          version: x.tag_name.replace(/^v/, ''),
          prerelease: x.prerelease,
          notes: (x.body ?? '').slice(0, 8000),
          url: x.html_url,
          publishedAt: x.published_at,
          draft: x.draft,
        }))
        .filter((x) => !x.draft && isVersion(x.version))
        .map(({ draft: _, ...x }) => x);
      c.error = null;
    } catch (e) {
      c.error = (e as Error).message;
      this.log.warn({ err: c.error }, 'panel releases');
    }
    c.checkedAt = new Date().toISOString();
    putSetting(this.db, CACHE_KEY, JSON.stringify(c));
    const top = this.newer()[0];
    if (top && getSetting(this.db, 'panel_update_notified') !== top.version) {
      putSetting(this.db, 'panel_update_notified', top.version);
      await this.onNew(top).catch(() => undefined);
    }
  }

  private requestFile() {
    return join(this.dataDir, 'update', 'request.json');
  }

  /** Запрос обновления службе на хосте: только известная версия новее текущей. */
  async request(version: string): Promise<void> {
    if (!this.managed)
      throw new Error('панель установлена не из релиза: обновление только из консоли сервера');
    if (!this.newer().some((r) => r.version === version))
      throw new Error(`версии ${version} нет среди новых в канале`);
    const dir = join(this.dataDir, 'update');
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, 'request.json.tmp');
    await writeFile(tmp, JSON.stringify({ version, at: new Date().toISOString() }));
    await rename(tmp, this.requestFile());
    this.requested = version;
  }

  /** Автообновление: включено, свой час (UTC), есть новая версия - запрос службе. */
  private async auto() {
    const s = this.settings();
    if (!s.autoUpdate || !this.managed || new Date().getUTCHours() !== s.autoHour) return;
    const top = this.newer()[0];
    if (!top || this.requested === top.version) return;
    await this.request(top.version).catch((e: Error) =>
      this.log.warn({ err: e.message }, 'panel auto update'),
    );
  }

  /**
   * После старта: версия панели сменилась с прошлого запуска - вернуть true один раз (для
   * раскатки агентов). Первый запуск (нет прошлой) - тоже обновление не считается.
   */
  versionChanged(): boolean {
    const prev = getSetting(this.db, 'panel_last_version');
    if (prev === this.current) return false;
    putSetting(this.db, 'panel_last_version', this.current);
    return Boolean(prev) && isVersion(this.current);
  }
}
