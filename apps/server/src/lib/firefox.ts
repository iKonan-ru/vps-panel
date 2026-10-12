import { createHash, createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { extensionVersion } from './extension.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import { getJsonSetting, getSetting, putSetting } from './settings.js';
import { zip } from './zip.js';

const AMO = 'https://addons.mozilla.org/api/v5';
const KEY_SETTING = 'firefox_amo';
const STATE_SETTING = 'firefox_state';

export interface FirefoxState {
  /** Подписанная версия расширения (есть архив в data/firefox). */
  signed: string | null;
  busy: boolean;
  error: string | null;
  at: string | null;
}

export interface FirefoxView extends FirefoxState {
  keySet: boolean;
  id: string;
  /** Версия расширения в этой панели (apps/extension/manifest.json). */
  version: string | null;
}

/**
 * Расширение Firefox: подпись у Mozilla (addons.mozilla.org, канал unlisted - в каталоге не
 * появляется) ключом API из Настроек - у каждой панели свой. ID - vps-panel-proxy@<домен
 * панели>, адрес обновлений и имя личных страниц - этой панели. Подписанные архивы и
 * updates.json - в DATA_DIR/firefox (раньше - FILES_DIR/firefox от tools/sign-firefox.mjs,
 * их панель тоже раздаёт). Новая версия расширения (после обновления панели) подписывается
 * сама; без ключа Firefox на личных страницах не показывается.
 */
export class FirefoxSigner {
  private busy = false;

  constructor(
    private db: Db,
    private box: SecretBox,
    private env: Env,
    private log: { warn: (o: unknown, m?: string) => void; info: (o: unknown, m?: string) => void },
  ) {}

  get dir() {
    return join(this.env.DATA_DIR, 'firefox');
  }

  private get panelDomain() {
    return new URL(this.env.PANEL_PUBLIC_URL).hostname;
  }

  get id(): string {
    return getSetting(this.db, 'firefox_id') || `vps-panel-proxy@${this.panelDomain}`;
  }

  private get subHost(): string {
    return this.env.SUB_DOMAIN || this.panelDomain;
  }

  start() {
    return schedule(() => void this.ensure(), 2 * 60_000, 6 * 60 * 60_000);
  }

  private key(): { issuer: string; secret: string } | null {
    const raw = getSetting(this.db, KEY_SETTING);
    if (!raw) return null;
    try {
      return JSON.parse(this.box.open(raw)) as { issuer: string; secret: string };
    } catch {
      return null;
    }
  }

  setKey(k: { issuer: string; secret: string } | null) {
    putSetting(this.db, KEY_SETTING, k ? this.box.seal(JSON.stringify(k)) : '');
  }

  private state(): FirefoxState {
    return getJsonSetting<FirefoxState>(this.db, STATE_SETTING, {
      signed: null,
      busy: false,
      error: null,
      at: null,
    });
  }

  private setState(patch: Partial<FirefoxState>) {
    putSetting(
      this.db,
      STATE_SETTING,
      JSON.stringify({ ...this.state(), ...patch, busy: this.busy }),
    );
  }

  view(): FirefoxView {
    return {
      ...this.state(),
      busy: this.busy,
      keySet: Boolean(this.key()),
      id: this.id,
      version: extensionVersion(this.env.EXTENSION_DIR),
    };
  }

  /** Подписать текущую версию, если ключ задан, а архива этой версии ещё нет. */
  async ensure(): Promise<void> {
    const v = extensionVersion(this.env.EXTENSION_DIR);
    if (!v || !this.key() || this.busy) return;
    if (existsSync(join(this.dir, `vps-panel-proxy-${v}.xpi`))) return;
    await this.sign().catch(() => undefined);
  }

  /** Подписать (или скачать уже подписанную) текущую версию и обновить updates.json. */
  async sign(): Promise<void> {
    const key = this.key();
    const version = extensionVersion(this.env.EXTENSION_DIR);
    if (!key) throw new Error('не задан ключ API addons.mozilla.org');
    if (!version) throw new Error('нет расширения в образе панели');
    if (this.busy) throw new Error('подпись уже идёт');
    this.busy = true;
    this.setState({ error: null });
    try {
      const xpi = await this.signed(key, version);
      mkdirSync(this.dir, { recursive: true });
      const name = `vps-panel-proxy-${version}.xpi`;
      writeFileSync(join(this.dir, name), xpi, { mode: 0o644 });
      const hash = createHash('sha256').update(xpi).digest('hex');
      const updates = {
        addons: {
          [this.id]: {
            updates: [
              {
                version,
                update_link: `https://${this.subHost}/sub/firefox/${name}`,
                update_hash: `sha256:${hash}`,
              },
            ],
          },
        },
      };
      writeFileSync(join(this.dir, 'updates.json'), `${JSON.stringify(updates, null, 2)}\n`, {
        mode: 0o644,
      });
      this.busy = false;
      this.setState({ signed: version, error: null, at: new Date().toISOString() });
      this.log.info({ version }, 'firefox: расширение подписано');
    } catch (e) {
      this.busy = false;
      this.setState({ error: (e as Error).message, at: new Date().toISOString() });
      this.log.warn({ err: (e as Error).message }, 'firefox: подпись');
      throw e;
    }
  }

  /** Сборка xpi из расширения Chrome (MV2 для Firefox). */
  private build(version: string): Buffer {
    const dir = this.env.EXTENSION_DIR;
    const chrome = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as {
      name: string;
      short_name?: string;
      description?: string;
      icons: Record<string, string>;
      action: { default_popup: string; default_title: string };
    };
    const manifest = {
      manifest_version: 2,
      name: chrome.name,
      short_name: chrome.short_name,
      version,
      description: chrome.description,
      browser_specific_settings: {
        gecko: {
          id: this.id,
          strict_min_version: '115.0',
          update_url: `https://${this.subHost}/sub/firefox/updates.json`,
          data_collection_permissions: { required: ['none'] },
        },
      },
      permissions: ['proxy', 'storage', 'alarms', 'privacy', '<all_urls>'],
      background: { scripts: ['rules.js', 'bg.js'], persistent: true },
      browser_action: {
        default_popup: chrome.action.default_popup,
        default_title: chrome.action.default_title,
        default_icon: chrome.icons,
      },
      icons: chrome.icons,
    };
    const files = [
      { name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`) },
      // имя личных страниц: с них расширение берёт ссылку при установке (только с этого имени)
      { name: 'firefox.json', data: Buffer.from(`${JSON.stringify({ subHost: this.subHost })}\n`) },
      ...[
        'bg.js',
        'rules.js',
        'popup.html',
        'popup.js',
        ...new Set(Object.values(chrome.icons)),
      ].map((n) => ({ name: n, data: readFileSync(join(dir, n)) })),
    ];
    return zip(files, new Date(2020, 0, 1));
  }

  /** JWT HS256 для API addons.mozilla.org: на каждый запрос свой, живёт минуту. */
  private jwt(key: { issuer: string; secret: string }): string {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const head = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ iss: key.issuer, jti: randomUUID(), iat: now, exp: now + 60 })}`;
    return `${head}.${createHmac('sha256', key.secret).update(head).digest('base64url')}`;
  }

  private async api(
    key: { issuer: string; secret: string },
    method: string,
    path: string,
    body?: FormData | object,
  ): Promise<{ status: number; json: Record<string, unknown> | null; text: string }> {
    const form = body instanceof FormData;
    const r = await fetch(path.startsWith('https://') ? path : `${AMO}${path}`, {
      method,
      headers: {
        Authorization: `JWT ${this.jwt(key)}`,
        ...(body && !form ? { 'Content-Type': 'application/json' } : {}),
      },
      body: form ? body : body ? JSON.stringify(body) : null,
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {}
    return { status: r.status, json, text };
  }

  /** Подписанный архив версии: уже подписанную Mozilla не подписывает второй раз - качаем. */
  private async signed(key: { issuer: string; secret: string }, version: string): Promise<Buffer> {
    const gid = encodeURIComponent(this.id);
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    type Ver = { file?: { status?: string; url?: string } };
    const get = async () => {
      const v = await this.api(key, 'GET', `/addons/addon/${gid}/versions/v${version}/`);
      if (v.status === 401 || v.status === 403)
        throw new Error(`ключ API не принят (HTTP ${v.status})`);
      return v.status === 200 ? (v.json as Ver) : null;
    };
    let v = await get();
    if (!v) {
      const form = new FormData();
      form.append('upload', new Blob([new Uint8Array(this.build(version))]), 'vps-panel-proxy.xpi');
      form.append('channel', 'unlisted');
      const up = await this.api(key, 'POST', '/addons/upload/', form);
      if (up.status !== 201 && up.status !== 200)
        throw new Error(`загрузка: HTTP ${up.status} ${up.text.slice(0, 200)}`);
      let u = up.json as {
        uuid: string;
        processed?: boolean;
        valid?: boolean;
        validation?: { messages?: { type: string; message: string }[] };
      };
      for (let i = 0; !u.processed && i < 100; i++) {
        await sleep(3000);
        u = (await this.api(key, 'GET', `/addons/upload/${u.uuid}/`)).json as typeof u;
      }
      if (!u.processed) throw new Error('проверка Mozilla не закончилась за 5 минут');
      if (!u.valid) {
        const errs = (u.validation?.messages ?? []).filter((m) => m.type === 'error');
        throw new Error(`проверка Mozilla не прошла: ${errs.map((m) => m.message).join('; ')}`);
      }
      const exists = (await this.api(key, 'GET', `/addons/addon/${gid}/`)).status === 200;
      const made = exists
        ? await this.api(key, 'POST', `/addons/addon/${gid}/versions/`, { upload: u.uuid })
        : await this.api(key, 'PUT', `/addons/addon/${gid}/`, { version: { upload: u.uuid } });
      if (made.status >= 300)
        throw new Error(`новая версия: HTTP ${made.status} ${made.text.slice(0, 200)}`);
    }
    // подпись unlisted - автоматическая, обычно минута-две
    for (let i = 0; i < 120; i++) {
      v = await get();
      const st = v?.file?.status;
      if (st === 'public' && v?.file?.url) break;
      if (st === 'disabled') throw new Error('Mozilla отклонила версию');
      await sleep(10_000);
    }
    const url = v?.file?.url;
    if (v?.file?.status !== 'public' || !url) throw new Error('подпись не готова за 20 минут');
    const r = await fetch(url, {
      headers: { Authorization: `JWT ${this.jwt(key)}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) throw new Error(`скачивание подписанного архива: HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

/** Каталоги с подписанным Firefox: панель (DATA_DIR) и прежняя раскладка (FILES_DIR). */
export function firefoxDirs(env: { DATA_DIR?: string; FILES_DIR?: string }): string[] {
  return [env.DATA_DIR, env.FILES_DIR]
    .filter((d): d is string => Boolean(d))
    .map((d) => join(d, 'firefox'));
}
