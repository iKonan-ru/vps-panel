import { describe, expect, it } from 'vitest';
import { pickPort, pickSubnet } from '../src/lib/awg-alloc.js';

describe('выбор подсети и порта для нового экземпляра AWG', () => {
  it('первая свободная 10.8.N.0 по всем серверам', () => {
    expect(pickSubnet(new Set())).toBe('10.8.1.0');
    expect(pickSubnet(new Set(['10.8.1', '10.8.2', '10.8.4']))).toBe('10.8.3.0');
  });
  it('порт не из занятых и в диапазоне 30000-59999', () => {
    const used = new Set(Array.from({ length: 29990 }, (_, i) => 30000 + i));
    for (let i = 0; i < 50; i++) {
      const p = Number(pickPort(used));
      expect(used.has(p)).toBe(false);
      expect(p).toBeGreaterThanOrEqual(30000);
      expect(p).toBeLessThan(60000);
    }
  });
});
