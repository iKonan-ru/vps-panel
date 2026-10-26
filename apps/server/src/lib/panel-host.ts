import { lookup } from 'node:dns/promises';
import type { Inventory } from '@vps/protocol';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { newId } from './ids.js';

const TTL_MS = 10 * 60_000;
const RETRY_MS = 30_000;

let cache: { at: number; ok: boolean; ips: string[] } = { at: 0, ok: false, ips: [] };

/** Адреса домена панели. Сбой DNS не стирает известные адреса и повторяется через 30 с. */
export async function panelAddresses(panelUrl: string): Promise<string[]> {
  if (Date.now() - cache.at < (cache.ok ? TTL_MS : RETRY_MS)) return cache.ips;
  let host = '';
  try {
    host = new URL(panelUrl).hostname;
    const ips = [host, ...(await lookup(host, { all: true })).map((a) => a.address)];
    cache = { at: Date.now(), ok: true, ips };
  } catch {
    const ips = cache.ips.length ? cache.ips : host ? [host] : [];
    cache = { at: Date.now(), ok: false, ips };
  }
  return cache.ips;
}

/** Сервер, на котором стоит сама панель: jail vps-panel ставит её установка. */
export function isPanelHost(host: string, inv: Inventory | undefined, panelIps: string[]): boolean {
  return Boolean(inv?.audit?.fail2banJails?.includes('vps-panel')) || panelIps.includes(host);
}

/** Имя нового сервера панели в списке серверов; занятое получает номер. */
const SELF_NAME = 'Сервер панели';

/**
 * Сервер панели в списке серверов (установка панели и restore): строка, чей адрес - один из
 * адресов панели (имя сервера - по DNS), иначе новая "Сервер панели" с адресом host.
 */
export async function ensurePanelServer(
  db: Db,
  panelIps: string[],
  host: string,
): Promise<{ id: string; name: string; created: boolean }> {
  const rows = await db
    .select({ id: servers.id, name: servers.name, host: servers.host })
    .from(servers);
  for (const r of rows) {
    if (panelIps.includes(r.host)) return { id: r.id, name: r.name, created: false };
  }
  for (const r of rows) {
    const ips = await lookup(r.host, { all: true }).then(
      (a) => a.map((x) => x.address),
      () => [] as string[],
    );
    if (ips.some((ip) => panelIps.includes(ip))) return { id: r.id, name: r.name, created: false };
  }
  const taken = new Set(rows.map((r) => r.name));
  let name = SELF_NAME;
  for (let i = 2; taken.has(name); i++) name = `${SELF_NAME} ${i}`;
  const id = newId();
  await db.insert(servers).values({ id, name, host });
  return { id, name, created: true };
}
