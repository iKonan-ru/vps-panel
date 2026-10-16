import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { backups, servers } from '../db/schema.js';
import type { UiHub } from './ui-hub.js';

const removedListeners = new Set<(serverId: string) => void>();

/** Состояние по серверу вне таблиц с каскадом (таймеры, кэши, записи в setting) - забыть. */
export function onServerRemoved(fn: (serverId: string) => void): () => void {
  removedListeners.add(fn);
  return () => {
    removedListeners.delete(fn);
  };
}

/** Резервные копии сервера удаляются вместе с ним: без сервера панель их не хранит. */
export function removeServer(
  deps: { db: Db; env: Env; registry: AgentRegistry; hub: UiHub },
  id: string,
): boolean {
  const { db, env, registry, hub } = deps;
  for (const b of db
    .select({ id: backups.id })
    .from(backups)
    .where(eq(backups.serverId, id))
    .all()) {
    const f = join(env.DATA_DIR, 'backups', `${b.id}.tar.gz`);
    if (existsSync(f)) unlinkSync(f);
  }
  db.delete(backups).where(eq(backups.serverId, id)).run();
  const res = db.delete(servers).where(eq(servers.id, id)).returning({ id: servers.id }).all();
  if (res.length === 0) return false;
  registry.get(id)?.ws.close(4005, 'server removed');
  for (const fn of removedListeners) fn(id);
  hub.broadcast({ type: 'server.changed', serverId: id });
  return true;
}
