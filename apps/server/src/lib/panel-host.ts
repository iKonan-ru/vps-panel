import { lookup } from 'node:dns/promises';
import type { Inventory } from '@vps/protocol';

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
