import type { Db } from '../db/index.js';
import { type GithubRelease, githubReleases } from './github.js';
import { schedule } from './schedule.js';
import { getJsonSetting, putSetting } from './settings.js';

/**
 * Клиентские приложения: свежая версия по ОС. Файлы не храним - ссылки на
 * релизы GitHub, где их нет - на магазины. Список релизов обновляется раз в 6 часов.
 */
export type AppOs = 'android' | 'ios' | 'windows' | 'macos' | 'linux';

type LinkDef =
  /** Файл из релиза репозитория: имя по шаблону (фрагменты ОС, ABI, расширения). */
  | { repo: string; asset: RegExp; label: string; note?: string }
  /** Постоянная ссылка: магазин, TestFlight, документация. */
  | { url: string; label: string; note?: string };

interface AppDef {
  id: string;
  name: string;
  /** Для чего: какой сервис панели и какой формат конфига. */
  purpose: string;
  platforms: Partial<Record<AppOs, LinkDef[]>>;
}

const NOT_IN_RU = 'в российском App Store нет';

export const APPS: AppDef[] = [
  {
    id: 'amneziawg',
    name: 'AmneziaWG',
    purpose: 'AWG: файл .conf или QR',
    platforms: {
      android: [
        { repo: 'amnezia-vpn/amneziawg-android', asset: /\.apk$/, label: 'APK' },
        {
          url: 'https://play.google.com/store/apps/details?id=org.amnezia.awg',
          label: 'Google Play',
        },
      ],
      ios: [{ url: 'https://apps.apple.com/app/amneziawg/id6478942365', label: 'App Store' }],
      macos: [{ url: 'https://apps.apple.com/app/amneziawg/id6478942365', label: 'App Store' }],
      windows: [
        {
          repo: 'amnezia-vpn/amneziawg-windows-client',
          asset: /^amneziawg-amd64-[\d.]+\.msi$/,
          label: 'MSI x64',
        },
      ],
      linux: [
        {
          url: 'https://github.com/amnezia-vpn/amneziawg-linux-kernel-module',
          label: 'Модуль ядра',
          note: 'без интерфейса: модуль ядра и awg-quick',
        },
      ],
    },
  },
  {
    id: 'amnezia-vpn',
    name: 'Amnezia VPN',
    purpose: 'AWG: ключ vpn:// или QR из кадров',
    platforms: {
      android: [
        {
          repo: 'amnezia-vpn/amnezia-client',
          asset: /_android11\+_arm64-v8a\.apk$/,
          label: 'APK',
          note: 'Android 11+, arm64',
        },
        {
          url: 'https://play.google.com/store/apps/details?id=org.amnezia.vpn',
          label: 'Google Play',
        },
      ],
      ios: [
        {
          url: 'https://apps.apple.com/us/app/amneziavpn/id1600529900',
          label: 'App Store',
          note: NOT_IN_RU,
        },
      ],
      windows: [
        { repo: 'amnezia-vpn/amnezia-client', asset: /_windows_x64\.exe$/, label: 'EXE x64' },
      ],
      macos: [{ repo: 'amnezia-vpn/amnezia-client', asset: /_macos_x64\.pkg$/, label: 'PKG' }],
      linux: [{ repo: 'amnezia-vpn/amnezia-client', asset: /_linux_x64\.run$/, label: 'RUN x64' }],
    },
  },
  {
    id: 'happ',
    name: 'Happ',
    purpose: 'VLESS: подписка 3X-UI',
    platforms: {
      android: [
        { repo: 'Happ-proxy/happ-android', asset: /^Happ\.apk$/, label: 'APK' },
        {
          url: 'https://play.google.com/store/apps/details?id=com.happproxy',
          label: 'Google Play',
        },
      ],
      ios: [
        {
          url: 'https://apps.apple.com/us/app/happ-proxy-utility/id6504287215',
          label: 'App Store',
          note: NOT_IN_RU,
        },
      ],
      windows: [
        { repo: 'Happ-proxy/happ-desktop', asset: /^setup-Happ\.x64\.exe$/, label: 'EXE x64' },
      ],
      macos: [
        { repo: 'Happ-proxy/happ-desktop', asset: /^Happ\.macOS\.universal\.dmg$/, label: 'DMG' },
      ],
      linux: [
        { repo: 'Happ-proxy/happ-desktop', asset: /^Happ\.linux\.x64\.deb$/, label: 'DEB x64' },
      ],
    },
  },
  {
    id: 'openflux',
    name: 'OpenFlux',
    purpose: 'OpenFlux: ссылка openflux:// или QR',
    platforms: {
      android: [
        {
          repo: 'p1neappleXpress/OpenFluxAndroid',
          asset: /^OpenFluxAndroid-[\d.]+-androidApp-universal-release\.apk$/,
          label: 'APK',
        },
        {
          repo: 'damnurmum/OpenFlux-Android',
          asset: /^OpenFlux-android-universal-release\.apk$/,
          label: 'APK форка',
          note: 'форк damnurmum/OpenFlux-Android',
        },
      ],
      ios: [
        {
          url: 'https://testflight.apple.com/join/BwnAcdus',
          label: 'TestFlight',
          note: 'предварительная версия',
        },
      ],
      windows: [
        {
          repo: 'p1neappleXpress/OpenFluxDesktop',
          asset: /^OpenFlux-[\d.]+-windows-x64-setup\.exe$/,
          label: 'EXE x64',
        },
      ],
      macos: [
        {
          repo: 'p1neappleXpress/OpenFluxDesktop',
          asset: /^OpenFlux-[\d.]+-macos-arm64\.dmg$/,
          label: 'DMG Apple',
        },
        {
          repo: 'p1neappleXpress/OpenFluxDesktop',
          asset: /^OpenFlux-[\d.]+-macos-x64\.dmg$/,
          label: 'DMG Intel',
        },
      ],
      linux: [
        {
          repo: 'p1neappleXpress/OpenFluxDesktop',
          asset: /^OpenFlux-[\d.]+-linux-x64\.deb$/,
          label: 'DEB x64',
        },
      ],
    },
  },
  {
    id: 'qwdtt',
    name: 'qWDTT',
    purpose: 'WDTT: ссылка wdtt:// или qwdtt://',
    platforms: {
      android: [
        { repo: 'SpaceNeuroX/proxy-turn-vk-android', asset: /universal.*\.apk$/, label: 'APK' },
      ],
      windows: [
        {
          repo: 'Regstar2/pwdtt',
          asset: /^pwdtt-windows-amd64-setup\.exe$/,
          label: 'EXE x64',
          note: 'PWDTT',
        },
      ],
      macos: [{ repo: 'Regstar2/pwdtt', asset: /^PWDTT-macos\.zip$/, label: 'ZIP', note: 'PWDTT' }],
      linux: [
        { repo: 'Regstar2/pwdtt', asset: /^pwdtt-linux-amd64$/, label: 'x64', note: 'PWDTT' },
      ],
    },
  },
];

export const OS_TITLES: Record<AppOs, string> = {
  android: 'Android',
  ios: 'iPhone и iPad',
  windows: 'Windows',
  macos: 'macOS',
  linux: 'Linux',
};

interface Release {
  tag: string;
  htmlUrl: string;
  publishedAt: string;
  assets: { name: string; url: string; size: number }[];
}
interface Cache {
  checkedAt?: string;
  repos: Record<string, { releases: Release[]; error?: string }>;
}

export interface AppLink {
  label: string;
  url: string;
  version?: string;
  note?: string;
}
export interface AppView {
  id: string;
  name: string;
  purpose: string;
  platforms: { os: AppOs; title: string; links: AppLink[] }[];
}

const KEY = 'app_releases';

export class AppReleases {
  constructor(
    private db: Db,
    /** Запрос наружу (GitHub) с хоста панели: напрямую, при сбое - через xray. */
    private fetchOut: (url: string, init?: RequestInit) => Promise<Response>,
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  start() {
    return schedule(() => void this.refresh(), 2 * 60_000, 6 * 60 * 60_000);
  }

  private load(): Cache {
    return getJsonSetting<Cache>(this.db, KEY, { repos: {} });
  }

  /**
   * Последние 10 релизов каждого репозитория (без черновиков и pre-release). Сбой по одному
   * репозиторию не стирает прежний список, только помечает ошибку.
   */
  async refresh(force = true): Promise<void> {
    const cache = this.load();
    // кнопка - не чаще раза в 5 минут: лимит GitHub (60 в час) общий с проверкой версий
    if (!force && cache.checkedAt && Date.now() - Date.parse(cache.checkedAt) < 5 * 60_000) return;
    let limited = '';
    const repos = [
      ...new Set(
        APPS.flatMap((a) => Object.values(a.platforms).flat()).flatMap((l) =>
          'repo' in l ? [l.repo] : [],
        ),
      ),
    ];
    for (const repo of repos) {
      if (limited) {
        cache.repos[repo] = { releases: cache.repos[repo]?.releases ?? [], error: limited };
        continue;
      }
      try {
        let list: GithubRelease[];
        try {
          list = await githubReleases(this.fetchOut, repo, 10);
        } catch (e) {
          // дальше спрашивать бесполезно: остальные репозитории получат ту же ошибку
          if ((e as { rateLimited?: boolean }).rateLimited) limited = (e as Error).message;
          throw e;
        }
        cache.repos[repo] = {
          releases: list
            .filter((x) => !x.draft && !x.prerelease)
            .map((x) => ({
              tag: x.tag_name,
              htmlUrl: x.html_url,
              publishedAt: x.published_at,
              assets: x.assets.map((a) => ({
                name: a.name,
                url: a.browser_download_url,
                size: a.size,
              })),
            })),
        };
      } catch (e) {
        const error = (e as Error).message;
        this.log.warn({ repo, err: error }, 'app releases');
        cache.repos[repo] = { releases: cache.repos[repo]?.releases ?? [], error };
      }
    }
    cache.checkedAt = new Date().toISOString();
    putSetting(this.db, KEY, JSON.stringify(cache));
  }

  /**
   * Ссылки по приложениям и ОС: файл - из самого свежего релиза, где он есть (бывают релизы без
   * части платформ); не нашёлся - страница последнего релиза.
   */
  list(): { checkedAt: string | null; apps: AppView[] } {
    const cache = this.load();
    const resolve = (l: LinkDef): AppLink => {
      if ('url' in l) return { label: l.label, url: l.url, ...(l.note ? { note: l.note } : {}) };
      const releases = cache.repos[l.repo]?.releases ?? [];
      for (const rel of releases) {
        const a = rel.assets.find((x) => l.asset.test(x.name));
        if (a)
          return {
            label: l.label,
            url: a.url,
            version: rel.tag,
            ...(l.note ? { note: l.note } : {}),
          };
      }
      const latest = releases[0];
      return latest
        ? {
            label: l.label,
            url: latest.htmlUrl,
            version: latest.tag,
            note: 'файл не найден, ссылка на страницу релиза',
          }
        : {
            label: l.label,
            url: `https://github.com/${l.repo}/releases`,
            note: cache.repos[l.repo]?.error
              ? `не удалось проверить: ${cache.repos[l.repo]?.error}`
              : 'версия ещё не проверялась',
          };
    };
    return {
      checkedAt: cache.checkedAt ?? null,
      apps: APPS.map((a) => ({
        id: a.id,
        name: a.name,
        purpose: a.purpose,
        platforms: (Object.keys(OS_TITLES) as AppOs[])
          .filter((os) => a.platforms[os]?.length)
          .map((os) => ({ os, title: OS_TITLES[os], links: (a.platforms[os] ?? []).map(resolve) })),
      })),
    };
  }
}
