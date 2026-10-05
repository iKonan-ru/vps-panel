import { and, eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { access } from '../db/schema.js';
import { upsertAccess } from './access.js';
import type { SecretBox } from './secret-box.js';

/** Сохранённый в "Доступах" API-токен 3X-UI сервера; пустая строка - не выпущен. */
export function savedXuiToken(db: Db, box: SecretBox, serverId: string): string {
  const row = db
    .select()
    .from(access)
    .where(and(eq(access.serverId, serverId), eq(access.kind, 'xui-api')))
    .get();
  return row ? box.open(row.fields[0]?.value ?? '') : '';
}

/** Записать выпущенный токен в "Доступы" (зашифрованным). */
export async function saveXuiToken(db: Db, box: SecretBox, serverId: string, token: string) {
  await upsertAccess(db, box, serverId, {
    kind: 'xui-api',
    title: 'API 3X-UI',
    fields: [{ label: 'Токен', value: token, secret: true }],
    note: 'Токен vps-panel для REST API 3X-UI; панель использует его для статуса и пользователей.',
  });
}

/** API-токен 3x-ui сервера: из "Доступов" или выпускаем через агента. */
export async function xuiToken(
  db: Db,
  box: SecretBox,
  registry: AgentRegistry,
  serverId: string,
): Promise<string> {
  const saved = savedXuiToken(db, box, serverId);
  if (saved) return saved;
  const r = (await registry.request(serverId, 'xui.token', {}, { timeoutMs: 60_000 })) as {
    token: string;
  };
  await saveXuiToken(db, box, serverId, r.token);
  return r.token;
}
