import type { GClientAccess } from '@vps/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { awgClients, gclientBindings, gclientExts, gclients, servers } from '../db/schema.js';
import { awgRef } from './gclient-services.js';
import { queued } from './gclients.js';
import { releaseOfDocs } from './openflux-docs.js';

interface TransferResult {
  /** Привязок перешло со старого сервера. */
  moved: number;
  /** Своих привязок нового сервера убрано (их записи заменила копия). */
  dropped: number;
  /** Клиентов, у которых доступ был ограничен списком серверов: старый заменён новым. */
  access: number;
}

/**
 * Перенос клиентов панели со старого сервера на новый после того, как на новом разложена копия
 * старого: записи клиентов в сервисах (пользователи 3X-UI, пиры AWG, пароли WDTT, секреты
 * MTProxyL) уже там, с теми же ключами. Привязки старого сервера переходят новому и встают в
 * очередь - синхронизация находит записи по ключам (а не заводит новые) и пересобирает ссылки
 * с адресом нового сервера. Свои привязки нового сервера (заведённые до переноса) убираются:
 * их записи заменила копия, а оставшись, они завели бы клиентам вторые записи.
 *
 * replaced - контейнеры AWG нового сервера, данные которых заменила копия: ключи панели для их
 * прежних пиров больше не нужны.
 */
export function transferClients(
  db: Db,
  from: string,
  to: string,
  replaced: string[] = [],
): TransferResult {
  return db.transaction((tx) => {
    const own = tx.select().from(gclientBindings).where(eq(gclientBindings.serverId, to)).all();
    for (const b of own) {
      if (b.service === 'openflux') releaseOfDocs(tx as unknown as Db, b.id);
      if (b.service === 'awg') {
        const { container, publicKey } = awgRef(b.ref);
        if (container && publicKey)
          tx.delete(awgClients)
            .where(
              and(
                eq(awgClients.serverId, to),
                eq(awgClients.container, container),
                eq(awgClients.publicKey, publicKey),
              ),
            )
            .run();
      }
    }
    tx.delete(gclientBindings).where(eq(gclientBindings.serverId, to)).run();
    if (replaced.length)
      tx.delete(awgClients)
        .where(and(eq(awgClients.serverId, to), inArray(awgClients.container, replaced)))
        .run();

    const moved = tx
      .update(gclientBindings)
      .set({ serverId: to, ...queued() })
      .where(eq(gclientBindings.serverId, from))
      .returning({ id: gclientBindings.id })
      .all().length;
    // приватные ключи пиров AWG, созданных панелью: по ним собираются конфиги клиентов
    tx.update(awgClients).set({ serverId: to }).where(eq(awgClients.serverId, from)).run();
    tx.update(gclientExts).set({ serverId: to }).where(eq(gclientExts.serverId, from)).run();

    // доступ клиента по списку серверов: старый сервер в списке заменяется новым
    let access = 0;
    for (const c of tx.select({ id: gclients.id, access: gclients.access }).from(gclients).all()) {
      const list = c.access as GClientAccess;
      if (!list?.some((a) => a.serverId === from)) continue;
      const old = list.find((a) => a.serverId === from);
      const mine = list.find((a) => a.serverId === to);
      const services = [...new Set([...(old?.services ?? []), ...(mine?.services ?? [])])];
      const next = [
        ...list.filter((a) => a.serverId !== from && a.serverId !== to),
        { serverId: to, services },
      ];
      tx.update(gclients).set({ access: next }).where(eq(gclients.id, c.id)).run();
      access++;
    }

    // синхронизация и исключённые inbound-ы 3X-UI (id те же: база 3X-UI из копии) - как у
    // старого; старый больше клиентов не получает
    const old = tx.select().from(servers).where(eq(servers.id, from)).get();
    if (old)
      tx.update(servers)
        .set({ gclients: old.gclients, xuiExcluded: old.xuiExcluded })
        .where(eq(servers.id, to))
        .run();
    tx.update(servers).set({ gclients: false }).where(eq(servers.id, from)).run();
    return { moved, dropped: own.length, access };
  });
}
