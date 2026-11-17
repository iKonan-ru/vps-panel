import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclients, openfluxDocs, servers } from '../src/db/schema.js';
import { addOfDocs, releaseOfDocs, takeOfDocs } from '../src/lib/openflux-docs.js';
import { forgetRetired, retireClients, transferClients } from '../src/lib/server-migrate.js';
import { getSetting } from '../src/lib/settings.js';

function setup() {
  const db = createDb(':memory:');
  for (const id of ['s0', 's1'])
    db.insert(servers).values({ id, name: id, host: '203.0.113.1' }).run();
  for (const id of ['c1', 'c2'])
    db.insert(gclients)
      .values({ id, name: id, slug: id, token: id.repeat(16) })
      .run();
  db.insert(gclientBindings)
    .values([
      { id: 'of', clientId: 'c1', serverId: 's0', service: 'openflux', ref: 'vp-aaaaaaaaaaaa' },
      { id: 'wd', clientId: 'c1', serverId: 's0', service: 'wdtt', secret: 'sealed' },
      { id: 'x2', clientId: 'c2', serverId: 's0', service: 'xui', ref: 'kolya', xuiInbounds: [3] },
    ])
    .run();
  addOfDocs(db, 'https://docs.yandex.ru/edit/d/AbCdEfGhIjKlMnOp12');
  takeOfDocs(db, 'of');
  return db;
}

describe('перенос: записи клиентов на оставленном старом сервере', () => {
  it('привязки на момент переноса возвращаются старому в очередь, документы - у нового', () => {
    const db = setup();
    transferClients(db, 's0', 's1');
    expect(getSetting(db, 'migrate_leftover:s0')).toBeTruthy();
    // клиента удалили до решения о старом сервере - его записи уже сняты синхронизацией
    db.delete(gclients).where(eq(gclients.id, 'c2')).run();

    expect(retireClients(db, 's0')).toBe(2);
    const left = db.select().from(gclientBindings).where(eq(gclientBindings.serverId, 's0')).all();
    expect(left.map((b) => [b.service, b.ref, b.secret, b.state]).sort()).toEqual([
      ['openflux', 'vp-aaaaaaaaaaaa', '', 'pending'],
      ['wdtt', '', 'sealed', 'pending'],
    ]);
    // снятие канала со старого сервера освобождает документы своей привязки - их нет
    for (const b of left) releaseOfDocs(db, b.id);
    expect(db.select().from(openfluxDocs).get()?.bindingId).toBe('of');
    expect(
      db
        .select()
        .from(gclientBindings)
        .where(eq(gclientBindings.serverId, 's1'))
        .all()
        .map((b) => b.id)
        .sort(),
    ).toEqual(['of', 'wd']);
    // снимок использован: повтор ничего не добавляет
    expect(getSetting(db, 'migrate_leftover:s0')).toBeUndefined();
    expect(retireClients(db, 's0')).toBe(0);
  });

  it('старый сервер снят или удалён - снимок забывается', () => {
    const db = setup();
    transferClients(db, 's0', 's1');
    forgetRetired(db, 's0');
    expect(getSetting(db, 'migrate_leftover:s0')).toBeUndefined();
    expect(retireClients(db, 's0')).toBe(0);
  });
});
