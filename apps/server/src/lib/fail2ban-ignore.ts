import { lookup } from 'node:dns/promises';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { join } from 'node:path';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { schedule } from './schedule.js';

/**
 * IP своих серверов - мимо fail2ban панели (jail vps-panel, deploy/fail2ban-panel.jail:
 * ignorecommand читает этот файл). Иначе пять ошибок пароля при входе через VPN на своём же
 * сервере банят его адрес на всех портах, и агент этого сервера час не может переподключиться.
 * Перебор пароля с этих адресов по-прежнему упирается в ограничение частоты входа и 2FA.
 */
export const IGNORE_FILE = 'fail2ban-ignore.txt';

/** Адрес как в журнале Caddy: IPv4 без "::ffff:", IPv6 как есть; не адрес - пусто. */
export function plainIp(v: string | undefined): string {
  const s = (v ?? '').trim().replace(/^::ffff:/i, '');
  return isIP(s) ? s : '';
}

/**
 * Список для файла: адреса серверов (имя - во все его адреса), адреса, с которых подключены
 * агенты (за NAT он отличается от адреса в карточке); без повторов, по порядку.
 */
export async function ignoreList(
  hosts: string[],
  agentAddrs: (string | undefined)[],
  resolve: (name: string) => Promise<string[]> = async (name) =>
    (await lookup(name, { all: true })).map((a) => a.address),
): Promise<string[]> {
  const out = new Set<string>();
  for (const h of hosts) {
    const ip = plainIp(h);
    if (ip) {
      out.add(ip);
      continue;
    }
    if (!/^[a-z0-9.-]{1,253}$/i.test(h)) continue;
    try {
      for (const a of await resolve(h)) {
        const r = plainIp(a);
        if (r) out.add(r);
      }
    } catch {
      // имя не разрешилось - в этот раз без него
    }
  }
  for (const a of agentAddrs) {
    const ip = plainIp(a);
    if (ip) out.add(ip);
  }
  return [...out].sort();
}

/** Переписать файл, если список изменился (атомарно: fail2ban не прочтёт половину). */
export function writeIgnoreFile(dataDir: string, ips: string[]): boolean {
  const path = join(dataDir, IGNORE_FILE);
  const text = ips.length ? `${ips.join('\n')}\n` : '';
  if (existsSync(path) && readFileSync(path, 'utf8') === text) return false;
  writeFileSync(`${path}.new`, text, { mode: 0o644 });
  renameSync(`${path}.new`, path);
  return true;
}

/** Держать файл свежим: при старте, раз в 5 минут и при подключении агента. */
export function startFail2banIgnore(
  db: Db,
  registry: AgentRegistry,
  dataDir: string,
  log: { warn: (o: unknown, m?: string) => void },
): () => void {
  let running = false;
  const sync = async () => {
    if (running) return;
    running = true;
    try {
      const rows = await db.select({ id: servers.id, host: servers.host }).from(servers);
      const addrs = rows.map((r) => registry.get(r.id)?.addr);
      writeIgnoreFile(
        dataDir,
        await ignoreList(
          rows.map((r) => r.host),
          addrs,
        ),
      );
    } catch (e) {
      log.warn({ err: (e as Error).message }, 'fail2ban-ignore');
    } finally {
      running = false;
    }
  };
  const onOnline = () => void sync();
  registry.on('online', onOnline);
  const stop = schedule(() => void sync(), 5_000, 5 * 60_000);
  return () => {
    stop();
    registry.off('online', onOnline);
  };
}
