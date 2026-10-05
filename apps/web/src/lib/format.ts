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

export function daysUntil(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86_400_000);
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
