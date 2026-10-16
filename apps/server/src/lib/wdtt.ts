import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { getJsonSetting, putSetting } from './settings.js';

/**
 * WDTT: пароли пользователей через admin API wdtt-server - агент ходит к
 * нему на 127.0.0.1 (операция wdtt.api). Пароль генерирует сервер, у пароля срок, лимит
 * устройств и трафик.
 */
export interface WdttPassword {
  password: string;
  label: string;
  vk_hash: string;
  ports: string;
  max_devices: number;
  device_ids: string[];
  expires_at: number;
  is_deactivated: boolean;
  down_bytes: number;
  up_bytes: number;
  active_devices: number;
}

interface WdttResponse {
  status: number;
  data?: unknown;
  text?: string;
  dtlsPort: number;
  wgPort: number;
}

/** Лимит паролей на сервер в сборке панели (у исходного сервера - 10). */
export const WDTT_PASSWORD_LIMIT = 200;

/** Вызов admin API через агента; ответ не 200 - ошибка с текстом сервера. */
export async function wdttApi(
  registry: AgentRegistry,
  serverId: string,
  method: 'GET' | 'POST',
  path: string,
  form: Record<string, string> = {},
): Promise<WdttResponse> {
  const r = (await registry.request(
    serverId,
    'wdtt.api',
    { method, path, form },
    { timeoutMs: 60_000 },
  )) as WdttResponse;
  if (r.status !== 200) {
    const msg = (r.data as { error?: string } | undefined)?.error ?? r.text ?? String(r.status);
    throw Object.assign(new Error(`WDTT: ${msg}`), { statusCode: 502 });
  }
  return r;
}

const HASHES_KEY = 'wdtt_vk_hashes';

/** Хеши звонков VK из настроек панели; пусто - клиенты берут свои в приложении. */
export function wdttHashes(db: Db): string[] {
  const v = getJsonSetting<unknown>(db, HASHES_KEY, []);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
}

/** Хеш звонка VK: id ссылки vk.com/call/join/<хеш>. */
export const VK_HASH_RE = /^[A-Za-z0-9_-]{8,128}$/;

export function setWdttHashes(db: Db, hashes: string[]) {
  putSetting(db, HASHES_KEY, JSON.stringify(hashes));
}

/**
 * Ссылки на пароль: qwdtt://config (оба Android-клиента qWDTT и PWDTT) и wdtt://.
 * Пробел - %20, а не "+": Android-клиент "+" не раскодирует.
 */
export function wdttLinks(o: {
  host: string;
  dtlsPort: number;
  wgPort: number;
  password: string;
  hashes: string[];
  name: string;
}) {
  const host = o.host.includes(':') ? `[${o.host}]` : o.host;
  const hashes = o.hashes.join(',');
  const q = {
    name: o.name,
    peer: `${host}:${o.dtlsPort}`,
    hashes,
    workers: '9',
    port: '9000',
    pass: o.password,
  };
  return {
    qwdtt: `qwdtt://config?${Object.entries(q)
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
      .join('&')}`,
    wdtt: `wdtt://${host}:${o.dtlsPort}:${o.wgPort}:9000:${o.password}:${hashes}`,
  };
}
