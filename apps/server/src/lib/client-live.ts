import type { GClientPresence, GLiveBinding, GLiveServer, GService } from '@vps/protocol';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import type { gclientBindings } from '../db/schema.js';
import { extServers } from './browser-ext.js';
import { ClientStatsHub, liveOnServer } from './client-stats.js';
import { wdttKey } from './gclient-services.js';
import type { SecretBox } from './secret-box.js';
import { savedXuiToken } from './xui-token.js';

type BindingRow = typeof gclientBindings.$inferSelect;

export interface LiveDeps {
  db: Db;
  box: SecretBox;
  hub: ClientStatsHub;
}

/** Снимки clients.stats серверов: один кэш на процесс - для карточек клиентов и уведомлений. */
export function createClientStatsHub(db: Db, box: SecretBox, registry: AgentRegistry) {
  return new ClientStatsHub({
    registry,
    xuiToken: (serverId) => {
      try {
        return savedXuiToken(db, box, serverId);
      } catch {
        return '';
      }
    },
  });
}

/**
 * Живая статистика привязок одного клиента: подключение и трафик. Ключи записей (пароль WDTT -
 * только хешем) наружу не уходят.
 */
export async function clientLive(
  deps: LiveDeps,
  client: { id: string; token: string },
  rows: BindingRow[],
): Promise<{ servers: GLiveServer[]; bindings: GLiveBinding[] }> {
  const { db, box, hub } = deps;
  const ids = [...new Set(rows.map((b) => b.serverId))];
  const snaps = new Map(
    await Promise.all(ids.map(async (id) => [id, await hub.server(id)] as const)),
  );
  const bindings = rows.flatMap((b) => {
    const s = snaps.get(b.serverId);
    if (!s) return [];
    let key = b.ref;
    if (b.service === 'wdtt') {
      try {
        key = b.secret ? wdttKey(box.open(b.secret)) : '';
      } catch {
        key = '';
      }
    }
    return [liveOnServer({ id: b.id, service: b.service as GService, ref: b.ref, key }, s)];
  });
  // прокси для браузера: подключений сервер не показывает - "на связи" по отчёту расширения
  const naive = new Map(
    rows
      .filter((b) => b.service === 'naive')
      .map((b) => [b.serverId, bindings.find((l) => l.bindingId === b.id)] as const),
  );
  if (naive.size) {
    const exts = extServers(
      db,
      client.id,
      client.token,
      (sid) => naive.get(sid)?.state === 'running',
    );
    for (const [sid, e] of exts) {
      const l = naive.get(sid);
      if (l?.state !== 'running') continue;
      l.state = 'online';
      l.lastSeen = e.seenAt;
      l.note = `расширение ${e.browser === 'firefox' ? 'Firefox' : 'Chrome'} ${e.version} включено${e.auto ? ' (\u00abАвто\u00bb: первый доступный сервер)' : ''}`;
    }
  }
  return { servers: [...snaps.values()].map((s) => s.info), bindings };
}

/** На связи ли клиент по живой статистике его привязок (плашка в списке клиентов). */
export function presenceOf(
  rows: { id: string; service: string; serverId: string }[],
  bindings: GLiveBinding[],
): GClientPresence {
  const service = new Map(rows.map((b) => [b.id, b.service as GService]));
  const server = new Map(rows.map((b) => [b.id, b.serverId]));
  const on = bindings.filter((l) => l.state === 'online');
  const seen = bindings.flatMap((l) => (l.lastSeen ? [l.lastSeen] : [])).sort();
  return {
    online: on.length > 0,
    services: [...new Set(on.flatMap((l) => service.get(l.bindingId) ?? []))],
    lastSeen: seen.at(-1) ?? null,
    serversOnline: new Set(on.flatMap((l) => server.get(l.bindingId) ?? [])).size,
    serversTotal: new Set(rows.map((b) => b.serverId)).size,
  };
}
