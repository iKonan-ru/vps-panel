import { describe, expect, it } from 'vitest';
import { daysToPayment, rollPaymentDate } from '../src/lib/billing.js';

const at = (s: string) => new Date(s).getTime();

describe('rollPaymentDate', () => {
  it('до дня оплаты дату не трогает', () => {
    expect(rollPaymentDate('2026-09-30T00:00:00.000Z', 1, at('2026-09-29T23:59:00Z'))).toBeNull();
    expect(rollPaymentDate('2026-10-05T00:00:00.000Z', 1, at('2026-09-29T20:00:00Z'))).toBeNull();
  });
  it('в день оплаты сдвигает на период', () => {
    expect(rollPaymentDate('2026-09-29T00:00:00.000Z', 1, at('2026-09-29T00:00:00Z'))).toBe(
      '2026-10-29T00:00:00.000Z',
    );
    expect(rollPaymentDate('2026-09-29T00:00:00.000Z', 12, at('2026-09-29T20:00:00Z'))).toBe(
      '2027-09-29T00:00:00.000Z',
    );
  });
  it('прошедшую дату сдвигает на период', () => {
    expect(rollPaymentDate('2026-09-28T00:00:00.000Z', 1, at('2026-09-29T00:30:00Z'))).toBe(
      '2026-10-28T00:00:00.000Z',
    );
  });
  it('пропущенные периоды проходит до ближайшей будущей даты', () => {
    expect(rollPaymentDate('2026-05-10T00:00:00.000Z', 3, at('2026-09-29T12:00:00Z'))).toBe(
      '2026-11-10T00:00:00.000Z',
    );
    expect(rollPaymentDate('2026-06-29T00:00:00.000Z', 3, at('2026-09-29T12:00:00Z'))).toBe(
      '2026-12-29T00:00:00.000Z',
    );
  });
  it('31 число в коротком месяце - последний день месяца', () => {
    expect(rollPaymentDate('2026-01-31T00:00:00.000Z', 1, at('2026-02-02T00:00:00Z'))).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });
});

describe('daysToPayment', () => {
  it('считает календарные дни, а не часы', () => {
    expect(daysToPayment('2026-10-10T00:00:00.000Z', at('2026-10-08T23:00:00Z'))).toBe(2);
    expect(daysToPayment('2026-10-10T00:00:00.000Z', at('2026-10-08T00:10:00Z'))).toBe(2);
    expect(daysToPayment('2026-10-10T00:00:00.000Z', at('2026-10-09T12:00:00Z'))).toBe(1);
    expect(daysToPayment('2026-10-10T00:00:00.000Z', at('2026-10-10T12:00:00Z'))).toBe(0);
  });
});
