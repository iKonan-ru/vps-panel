import { nextTagColor } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { ensureTags, listTags, removeTag, updateTag } from '../src/lib/tags.js';

function setup() {
  const db = createDb(':memory:');
  db.insert(servers)
    .values([
      { id: 's1', name: 'Hoster', host: '203.0.113.5' },
      { id: 's2', name: 'NetCore', host: '198.51.100.7' },
    ])
    .run();
  return { db };
}

const tagsOf = (db: ReturnType<typeof createDb>, id: string) =>
  db
    .select({ id: servers.id, tags: servers.tags })
    .from(servers)
    .all()
    .find((s) => s.id === id)?.tags;

describe('теги серверов', () => {
  it('цвет нового тега - первый свободный, потом самый редкий', () => {
    expect(nextTagColor([])).toBe('sky');
    expect(nextTagColor(['sky', 'teal'])).toBe('orange');
    const all = ['sky', 'orange', 'teal', 'rose', 'violet', 'amber', 'green', 'pink', 'indigo'];
    expect(nextTagColor([...all, 'slate', ...all])).toBe('slate');
  });

  it('имена приводятся к справочнику без учёта регистра, и для кириллицы', () => {
    const { db } = setup();
    expect(ensureTags(db, ['Москва', '  vpn ', ''])).toEqual(['Москва', 'vpn']);
    expect(ensureTags(db, ['МОСКВА', 'VPN', 'vpn', 'de'])).toEqual(['Москва', 'vpn', 'de']);
    expect(listTags(db).map((t) => [t.name, t.color])).toEqual([
      ['Москва', 'sky'],
      ['de', 'teal'],
      ['vpn', 'orange'],
    ]);
  });

  it('список считает серверы; переименование меняет тег на серверах', () => {
    const { db } = setup();
    const a = ensureTags(db, ['fi', 'vpn']);
    db.update(servers).set({ tags: a }).run();
    expect(listTags(db).find((t) => t.name === 'fi')?.servers).toBe(2);
    expect(updateTag(db, 'FI', { name: 'Финляндия', color: 'green' })?.sort()).toEqual([
      's1',
      's2',
    ]);
    expect(tagsOf(db, 's1')).toEqual(['Финляндия', 'vpn']);
    expect(listTags(db).find((t) => t.name === 'Финляндия')?.color).toBe('green');
    expect(updateTag(db, 'нет такого', { color: 'rose' })).toBeNull();
  });

  it('имя другого тега - слияние без повторов; удаление снимает тег с серверов', () => {
    const { db } = setup();
    db.update(servers)
      .set({ tags: ensureTags(db, ['fi', 'finland']) })
      .run();
    updateTag(db, 'finland', { name: 'FI' });
    expect(tagsOf(db, 's2')).toEqual(['fi']);
    expect(listTags(db).map((t) => t.name)).toEqual(['fi']);
    expect(removeTag(db, 'fi')?.length).toBe(2);
    expect(tagsOf(db, 's1')).toEqual([]);
    expect(listTags(db)).toEqual([]);
  });

  it('только цвет - серверы не трогаются', () => {
    const { db } = setup();
    ensureTags(db, ['de']);
    expect(updateTag(db, 'de', { color: 'pink' })).toEqual([]);
    expect(listTags(db)[0]).toEqual({ name: 'de', color: 'pink', servers: 0 });
  });
});
