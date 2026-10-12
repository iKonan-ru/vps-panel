import type { AgentRegistry } from '../agents/registry.js';
import { githubError } from './github.js';

/**
 * Версии движка telemt MTProxyL. Готовые образы docker MTProxyL кладёт в
 * ghcr.io/liafanx/mtproxyl-telemt с тегом "<версия>-<коммит релиза>". Если образа версии нет,
 * `mtproxyl engine update` собирает telemt из исходников (Rust) прямо на сервере - на слабом
 * сервере это может его подвесить. Поэтому ставить можно только версии с готовым образом, а
 * при носителе-бинарнике - любые (бинарник скачивается готовым из релизов telemt). Образ,
 * лежащий на сервере, от сборки не спасает: engine update удаляет его и тянет из реестра.
 */
const IMAGE = 'liafanx/mtproxyl-telemt';
const RELEASES = 'https://api.github.com/repos/telemt/telemt/releases?per_page=30';

export interface EngineVersion {
  tag: string;
  date: string;
  prerelease: boolean;
  installed: boolean;
  /** Готовый образ есть в реестре. */
  image: boolean;
  /** Ставится без сборки на сервере. */
  ready: boolean;
}

export interface EngineInfo {
  current: string;
  binary: boolean;
  versions: EngineVersion[];
  /** Реестр образов не ответил: версии docker ставить нельзя (не знаем, будет ли сборка). */
  registryError?: string;
}

const norm = (v: string) => v.trim().replace(/^v/i, '').split('-')[0] ?? '';

export class EngineCatalog {
  private cache: { at: number; tags: Set<string>; commits: Map<string, string> } | null = null;

  constructor(
    private registry: AgentRegistry,
    /** Запрос наружу с хоста панели (ghcr.io, GitHub): напрямую, при сбое - через xray. */
    private fetchOut: (url: string, init?: RequestInit) => Promise<Response>,
  ) {}

  /** Теги готовых образов и коммиты релизов telemt; один запрос на все серверы, кэш на час. */
  private async catalog() {
    if (this.cache && Date.now() - this.cache.at < 60 * 60_000) return this.cache;
    const t = await this.fetchOut(`https://ghcr.io/token?scope=repository:${IMAGE}:pull`);
    if (!t.ok) throw new Error(`ghcr.io: ${t.status}`);
    const { token } = (await t.json()) as { token: string };
    const l = await this.fetchOut(`https://ghcr.io/v2/${IMAGE}/tags/list?n=1000`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!l.ok) throw new Error(`ghcr.io: ${l.status}`);
    const tags = new Set(((await l.json()) as { tags?: string[] }).tags ?? []);
    const r = await this.fetchOut(RELEASES, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'vps-panel' },
    });
    if (!r.ok) throw githubError(r);
    const rel = (await r.json()) as { tag_name: string; target_commitish: string }[];
    const commits = new Map(rel.map((x) => [x.tag_name, x.target_commitish]));
    this.cache = { at: Date.now(), tags, commits };
    return this.cache;
  }

  /** Тег образа считается как в MTProxyL: версия и 7 знаков коммита релиза. */
  private hasImage(c: { tags: Set<string>; commits: Map<string, string> }, tag: string) {
    const sha = c.commits.get(tag) ?? '';
    if (/^[0-9a-f]{7,40}$/.test(sha)) return c.tags.has(`${norm(tag)}-${sha.slice(0, 7)}`);
    return [...c.tags].some((t) => t.startsWith(`${norm(tag)}-`));
  }

  /** Что стоит на сервере и что можно поставить без сборки. */
  async info(serverId: string): Promise<EngineInfo> {
    const r = (await this.registry.request(
      serverId,
      'mtproxyl.exec',
      { op: 'engine.versions', args: {} },
      { timeoutMs: 90_000 },
    )) as { output?: string };
    const v = JSON.parse((r.output ?? '').trim()) as {
      current: string;
      binary: boolean;
      releases: { tag: string; date: string }[];
    };
    let c: Awaited<ReturnType<EngineCatalog['catalog']>> | null = null;
    let registryError: string | undefined;
    if (!v.binary)
      try {
        c = await this.catalog();
      } catch (e) {
        registryError = (e as Error).message;
      }
    const versions = v.releases.map((x) => {
      const image = c ? this.hasImage(c, x.tag) : false;
      return {
        tag: x.tag,
        // pre-release MTProxyL помечает в дате: "2026-09-29 (pre-release)"
        date: x.date.replace(/\s*\(pre-release\)/, ''),
        prerelease: x.date.includes('pre-release'),
        installed: norm(v.current) === norm(x.tag),
        image,
        ready: v.binary || image,
      };
    });
    return {
      current: norm(v.current),
      binary: v.binary,
      versions,
      ...(registryError ? { registryError } : {}),
    };
  }
}
