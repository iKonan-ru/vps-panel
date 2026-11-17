import { NAME_ADJECTIVES, NAME_ANIMALS, NAME_PLANTS, randomServerName } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/lib/panel-proxy.js';

describe('случайные имена серверов', () => {
  it('"Прилагательное Животное/Растение" латиницей; поддомен - то же через дефис', () => {
    for (let i = 0; i < 200; i++) {
      const name = randomServerName();
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(slugify(name)).toBe(name.toLowerCase().replace(' ', '-'));
    }
    const nouns = [...NAME_ANIMALS, ...NAME_PLANTS];
    for (const w of [...NAME_ADJECTIVES, ...nouns]) expect(w).toMatch(/^[a-z]{2,12}$/);
    expect(new Set(NAME_ADJECTIVES).size).toBe(NAME_ADJECTIVES.length);
    expect(new Set(nouns).size).toBe(nouns.length);
    // слово - либо прилагательное, либо существительное: иначе "повтор слова" неоднозначен
    expect(NAME_ADJECTIVES.filter((a) => (nouns as string[]).includes(a))).toEqual([]);
  });

  it('слова занятых имён не повторяются: ни прилагательное, ни существительное', () => {
    const first = () => 0;
    expect(randomServerName([], first)).toBe('Agile Alpaca');
    // и в виде поддомена, и в любом регистре
    expect(randomServerName(['agile-alpaca'], first)).toBe('Amber Axolotl');
    expect(randomServerName(['AGILE Badger', 'Ancient alpaca'], first)).toBe('Amber Axolotl');
    // свои имена ("NetCore") слов словаря не занимают
    expect(randomServerName(['NetCore', 'SkyHost'], first)).toBe('Agile Alpaca');
    const taken = ['Brave Lynx', 'Calm Heron', 'Misty Willow'];
    for (let i = 0; i < 300; i++) {
      const [adj, noun] = randomServerName(taken).toLowerCase().split(' ');
      expect(['brave', 'calm', 'misty']).not.toContain(adj);
      expect(['lynx', 'heron', 'willow']).not.toContain(noun);
    }
  });

  it('свободные слова кончились - повтор слова, но не имени; все сочетания заняты - номер', () => {
    const first = () => 0;
    // все прилагательные заняты: прилагательное повторяется, существительное - свободное
    const allAdj = NAME_ADJECTIVES.map((a, i) => `${a} ${NAME_PLANTS[i % NAME_PLANTS.length]}`);
    const name = randomServerName(allAdj, first);
    expect(name).toBe('Agile Alpaca');
    // единственное сочетание занято - номер
    const one = () => 0;
    const taken = ['Agile Alpaca'];
    for (const a of NAME_ADJECTIVES.slice(1)) taken.push(`${a} alpaca`);
    for (const n of [...NAME_ANIMALS, ...NAME_PLANTS].slice(1)) taken.push(`agile ${n}`);
    expect(randomServerName(taken, one)).toBe('Agile Alpaca 2');
    expect(randomServerName([...taken, 'agile alpaca 2'], one)).toBe('Agile Alpaca 3');
  });
});
