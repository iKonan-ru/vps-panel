import type { Metrics } from '@vps/protocol';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { gclientBindings, gclients, servers } from '../db/schema.js';
import { cascadeClientEmail, isCascadeClient } from './cascades.js';

/**
 * Подписи пользователей xray в метриках сервера: email клиента - имя клиента панели, служебный
 * клиент каскада - вход каскада. Подпись агента не берётся: name и kind ставит только панель.
 */
export function labelConns(db: Db, serverId: string, m: Metrics | null): Metrics | null {
  const top = m?.conns?.top;
  if (!m?.conns || !top?.length) return m;
  const clients = new Map(
    db
      .select({ ref: gclientBindings.ref, name: gclients.name })
      .from(gclientBindings)
      .innerJoin(gclients, eq(gclients.id, gclientBindings.clientId))
      .where(and(eq(gclientBindings.serverId, serverId), eq(gclientBindings.service, 'xui')))
      .all()
      .map((r) => [r.ref, r.name]),
  );
  const entries = new Map(
    db
      .select({ id: servers.id, name: servers.name })
      .from(servers)
      .all()
      .map((s) => [cascadeClientEmail(s.id), s.name]),
  );
  return {
    ...m,
    conns: {
      ...m.conns,
      top: top.map(({ ref, conns, ips }) => {
        const entry = isCascadeClient(ref) ? entries.get(ref) : undefined;
        const client = clients.get(ref);
        return {
          ref,
          conns,
          ips,
          ...(entry !== undefined
            ? { name: entry, kind: 'cascade' as const }
            : client !== undefined
              ? { name: client, kind: 'client' as const }
              : {}),
        };
      }),
    },
  };
}
