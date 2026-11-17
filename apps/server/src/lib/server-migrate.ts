import type { GClientAccess } from '@vps/protocol';
import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { awgClients, gclientBindings, gclientExts, gclients, servers } from '../db/schema.js';
import { awgRef } from './gclient-services.js';
import { queued } from './gclients.js';
import { newId } from './ids.js';
import { releaseOfDocs } from './openflux-docs.js';
import { deleteSetting, getSetting, putSetting } from './settings.js';

type Leftover = Pick<
  typeof gclientBindings.$inferSelect,
  'clientId' | 'deviceId' | 'service' | 'ref' | 'secret' | 'xuiInbounds'
>;

/** Привязки старого сервера на момент переноса: по ним снимаются его записи клиентов. */
const leftoverKey = (from: string) => `migrate_leftover:${from}`;

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
    // записи клиентов на старом сервере остаются, пока не решено, что с ним делать
    const left: Leftover[] = tx
      .select()
      .from(gclientBindings)
      .where(eq(gclientBindings.serverId, from))
      .all()
      .map(({ clientId, deviceId, service, ref, secret, xuiInbounds }) => ({
        clientId,
        deviceId,
        service,
        ref,
        secret,
        xuiInbounds,
      }));
    putSetting(tx as unknown as Db, leftoverKey(from), JSON.stringify(left));
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

/**
 * Старый сервер оставлен в панели: записи перенесённых клиентов (пользователи, пиры, пароли,
 * каналы) снимаются с него. Привязки на момент переноса возвращаются старому серверу в очередь;
 * клиенты на нём больше не включены, и синхронизация удаляет записи на сервере, а затем
 * привязки. Не в сети - снимет, когда вернётся. Документы OpenFlux остаются у привязок нового
 * сервера. Возвращает число привязок к снятию.
 */
export function retireClients(db: Db, from: string): number {
  const raw = getSetting(db, leftoverKey(from));
  if (!raw) return 0;
  return db.transaction((tx) => {
    const alive = new Set(
      tx
        .select({ id: gclients.id })
        .from(gclients)
        .all()
        .map((c) => c.id),
    );
    const left = (JSON.parse(raw) as Leftover[]).filter((b) => alive.has(b.clientId));
    for (const b of left)
      tx.insert(gclientBindings)
        .values({ ...b, id: newId(), serverId: from, links: [], error: '', ...queued() })
        .run();
    deleteSetting(tx as unknown as Db, leftoverKey(from));
    return left.length;
  });
}

/** Старый сервер снят или удалён из панели: привязки на момент переноса больше не нужны. */
export function forgetRetired(db: Db, from: string) {
  deleteSetting(db, leftoverKey(from));
}
