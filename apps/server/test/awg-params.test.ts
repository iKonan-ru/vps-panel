import { describe, expect, it } from 'vitest';
import { generateAwgParams, validateAwgParams } from '../src/lib/awg-params.js';

describe('generateAwgParams', () => {
  for (const profile of ['3.1', '2.0', '1.0'] as const)
    it(`${profile}: 500 генераций подряд проходят проверку`, () => {
      for (let i = 0; i < 500; i++)
        expect(validateAwgParams(generateAwgParams(profile))).toEqual([]);
    });
  it('3.1: как у приложения Amnezia 5.0.3', () => {
    const p = generateAwgParams('3.1');
    expect(p.S1).toBe('12');
    expect(p.H4).toBe('4');
    expect(p.HeaderProtectionKey).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(p.RandomTrailers).toBe('on');
    expect(p.ContentPaddingAddition).toBeUndefined();
  });
  it('2.0: диапазоны заголовков, S3 и S4, без ключей 3.x', () => {
    const p = generateAwgParams('2.0');
    expect(p.H1).toMatch(/^\d+-\d+$/);
    expect(p.S3).toBeDefined();
    expect(p.HeaderProtectionKey).toBeUndefined();
  });
  it('1.0: одиночные заголовки, только S1 и S2, без I1', () => {
    const p = generateAwgParams('1.0');
    expect(p.H1).toMatch(/^\d+$/);
    expect(p.S3).toBeUndefined();
    expect(p.I1).toBeUndefined();
  });
});

describe('validateAwgParams', () => {
  it('ловит нарушения правил протокола', () => {
    const errors = validateAwgParams({
      Jmin: '60',
      Jmax: '50',
      S1: '20',
      S2: '76', // 148+20 = 92+76
      H1: '5-100',
      H2: '50-200', // пересекается с H1
      HeaderProtectionKey: 'x', // все S должны быть >= 12
      S3: '5',
      RekeyAfterTime: '100-120',
      RejectAfterTime: '110-180',
      RandomTrailers: 'true',
    });
    const text = errors.join('\n');
    expect(text).toContain('Jmin больше Jmax');
    expect(text).toContain('S1 и S2');
    expect(text).toContain('H1 и H2 пересекаются');
    expect(text).toContain('S3: с HeaderProtectionKey');
    expect(text).toContain('RejectAfterTime');
    expect(text).toContain('RandomTrailers');
  });
});
