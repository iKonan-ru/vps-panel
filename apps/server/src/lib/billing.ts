const DAY = 86_400_000;

/** Начало суток (UTC), в которые попадает момент. Даты платежей хранятся как полночь UTC. */
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;

/**
 * Следующая дата платежа: если день оплаты наступил или прошёл, дата сдвигается на период
 * (billingMonths месяцев) столько раз, чтобы стать будущей. В сам день оплаты показывается
 * уже следующая дата. Число месяца, которого нет в новом месяце (31 -> февраль), становится
 * последним днём месяца. null - сдвигать не нужно.
 */
export function rollPaymentDate(iso: string, months: number, now = Date.now()): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || months < 1) return null;
  const tomorrow = dayStart(now) + DAY;
  if (d.getTime() >= tomorrow) return null;
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let t = d.getTime();
  while (t < tomorrow) {
    m += months;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    t = Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes());
  }
  return new Date(t).toISOString();
}

/** Сколько календарных дней (UTC) до даты платежа: 0 - сегодня, 1 - завтра. */
export function daysToPayment(iso: string, now = Date.now()): number {
  return Math.round((dayStart(new Date(iso).getTime()) - dayStart(now)) / DAY);
}
