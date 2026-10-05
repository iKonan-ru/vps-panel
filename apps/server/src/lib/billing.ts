const DAY = 86_400_000;

/**
 * Следующая дата платежа: если день оплаты уже прошёл, дата сдвигается на период
 * (billingMonths месяцев) столько раз, чтобы стать сегодняшней или будущей.
 * В сам день оплаты дата не меняется. Число месяца, которого нет в новом месяце
 * (31 -> февраль), становится последним днём месяца. null - сдвигать не нужно.
 */
export function rollPaymentDate(iso: string, months: number, now = Date.now()): string | null {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || months < 1) return null;
  if (d.getTime() + DAY > now) return null;
  const day = d.getUTCDate();
  const y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let t = d.getTime();
  while (t + DAY <= now) {
    m += months;
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    t = Date.UTC(y, m, Math.min(day, last), d.getUTCHours(), d.getUTCMinutes());
  }
  return new Date(t).toISOString();
}
