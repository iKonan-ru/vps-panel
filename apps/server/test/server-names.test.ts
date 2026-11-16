import { NAME_ADJECTIVES, NAME_ANIMALS, randomServerName } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/lib/panel-proxy.js';

describe('случайные имена серверов', () => {
  it('"Прилагательное Животное" латиницей; поддомен - то же через дефис', () => {
    for (let i = 0; i < 200; i++) {
      const name = randomServerName();
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
      expect(slugify(name)).toBe(name.toLowerCase().replace(' ', '-'));
    }
    for (const w of [...NAME_ADJECTIVES, ...NAME_ANIMALS]) expect(w).toMatch(/^[a-z]{2,12}$/);
    expect(new Set(NAME_ADJECTIVES).size).toBe(NAME_ADJECTIVES.length);
    expect(new Set(NAME_ANIMALS).size).toBe(NAME_ANIMALS.length);
  });

  it('занятые имена (и по виду в поддомене) не повторяются; все заняты - с номером', () => {
    const first = () => 0;
    expect(randomServerName([], first)).toBe('Agile Alpaca');
    // "agile-alpaca" дало бы тот же поддомен: при одном варианте - номер
    expect(randomServerName(['agile-alpaca'], first)).toBe('Agile Alpaca 2');
    expect(randomServerName(['Agile Alpaca', 'agile alpaca 2'], first)).toBe('Agile Alpaca 3');
    let n = 0;
    const seq = () => [0, 0, 0.99, 0.99][n++ % 4] ?? 0;
    expect(randomServerName(['AGILE ALPACA'], seq)).toBe('Zesty Zebra');
  });
});
