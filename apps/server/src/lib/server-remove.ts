import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Env } from '../config.js';
import type { Db } from '../db/index.js';
import { backups, servers } from '../db/schema.js';
import type { UiHub } from './ui-hub.js';

/**
 * Удалить сервер из панели: агент отключается (его токен больше не действует), резервные копии
 * сервера - вместе с ним (файлы копий у владельца, панель их без сервера не хранит), остальное
 * (привязки, доступы, ключи AWG) - каскадом базы. Не было такого - false.
 */
export function removeServer(
  deps: { db: Db; env: Env; registry: AgentRegistry; hub: UiHub },
  id: string,
): boolean {
  const { db, env, registry, hub } = deps;
  registry.get(id)?.ws.close(4005, 'server removed');
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
  hub.broadcast({ type: 'server.changed', serverId: id });
  return true;
}
