import { NAME_ADJECTIVES, NAME_ANIMALS, randomServerName } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { slugify } from '../src/lib/panel-proxy.js';

describe('случайные имена серверов', () => {
  it('прилагательное-животное латиницей: имя без изменений годится в поддомен', () => {
    for (let i = 0; i < 200; i++) {
      const name = randomServerName();
      expect(name).toMatch(/^[a-z]+-[a-z]+$/);
      expect(slugify(name)).toBe(name);
    }
    for (const w of [...NAME_ADJECTIVES, ...NAME_ANIMALS]) expect(w).toMatch(/^[a-z]{2,12}$/);
    expect(new Set(NAME_ADJECTIVES).size).toBe(NAME_ADJECTIVES.length);
    expect(new Set(NAME_ANIMALS).size).toBe(NAME_ANIMALS.length);
  });

  it('занятые имена не повторяются; все заняты - с номером', () => {
    const first = () => 0;
    expect(randomServerName([], first)).toBe('agile-alpaca');
    // занято без учёта регистра - выпадает другое, а при одном варианте - номер
    expect(randomServerName(['Agile-Alpaca'], first)).toBe('agile-alpaca-2');
    expect(randomServerName(['agile-alpaca', 'agile-alpaca-2'], first)).toBe('agile-alpaca-3');
    let n = 0;
    const seq = () => [0, 0, 0.99, 0.99][n++ % 4] ?? 0;
    expect(randomServerName(['agile-alpaca'], seq)).toBe('zesty-zebra');
  });
});
