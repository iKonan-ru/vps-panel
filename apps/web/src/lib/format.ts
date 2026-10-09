/** Человеческие форматы для интерфейса. */

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} ч назад`;
  return `${Math.round(h / 24)} дн назад`;
}

export function uptime(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)} мин`;
  if (sec < 86_400) return `${Math.round(sec / 3600)} ч`;
  return `${Math.round(sec / 86_400)} дн`;
}

export function gb(v: number): string {
  return v >= 100 ? String(Math.round(v)) : v.toFixed(1);
}

/** Период оплаты словами: 1 - мес, 3 - 3 мес, 12 - год. */
export function periodLabel(months: number): string {
  if (months === 1) return 'мес';
  if (months === 12) return 'год';
  if (months % 12 === 0) return `${months / 12} г.`;
  return `${months} мес`;
}

export function money(price: number | null, currency: string, months: number): string {
  if (price === null) return '';
  const sym = { RUB: 'руб.', EUR: 'EUR', USD: 'USD' }[currency] ?? currency;
  return `${price.toLocaleString('ru-RU')} ${sym}/${periodLabel(months)}`;
}

/** Сумма в пересчёте на месяц, для сравнения серверов. */
export function perMonth(price: number | null, currency: string, months: number): string {
  if (price === null || months <= 1) return '';
  const sym = { RUB: 'руб.', EUR: 'EUR', USD: 'USD' }[currency] ?? currency;
  return `${(price / months).toLocaleString('ru-RU', { maximumFractionDigits: 0 })} ${sym}/мес`;
}

/** Дата и время для журналов: 03.10 21:15. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function dateShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Календарных дней до даты (по местному времени): 0 - сегодня, 1 - завтра. */
export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  const d = new Date(iso);
  const now = new Date();
  const a = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  const b = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((a - b) / 86_400_000);
}

/** За сколько дней до платежа хостингу дата подсвечивается. */
export const PAYMENT_SOON_DAYS = 2;

/** Платёж скоро: дата в ближайшие PAYMENT_SOON_DAYS дней. */
export function paymentSoon(days: number | null): days is number {
  return days !== null && days <= PAYMENT_SOON_DAYS;
}

/** Форма слова для числа: 1 вопрос, 2 вопроса, 5 вопросов. */
export function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20)) return few;
  return many;
}

/** "сегодня", "завтра", "через 2 дн". */
export function daysWord(days: number): string {
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${days} дн`;
}

/** Версия агента "0.2.0+20260926.0145.abc1234" -> "0.2.0 (26.09 01:45)". */
export function agentVersionShort(v: string | null | undefined): string {
  if (!v) return '';
  const m = /^([^+]+)\+(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})/.exec(v);
  if (!m) return v;
  return `${m[1]} (${m[4]}.${m[3]} ${m[5]}:${m[6]})`;
}

/** Байты в человеческий вид: 12.3 МБ, 1.2 ГБ. */
export function bytes(n: number): string {
  if (!n) return '0 Б';
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}
