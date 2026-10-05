import { lookup } from 'node:dns/promises';

let cache: { at: number; ips: string[] } = { at: 0, ips: [] };

/**
 * Адреса домена панели: сервер с таким адресом - сервер панели (признак panelHost).
 * DNS - не чаще раза в 10 минут.
 */
export async function panelAddresses(panelUrl: string): Promise<string[]> {
  if (Date.now() - cache.at < 10 * 60_000) return cache.ips;
  let ips: string[] = [];
  try {
    const host = new URL(panelUrl).hostname;
    ips = [host, ...(await lookup(host, { all: true })).map((a) => a.address)];
  } catch {}
  cache = { at: Date.now(), ips };
  return ips;
}
