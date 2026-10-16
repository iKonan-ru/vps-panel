/** Неразрывный пробел: число и единица (5 мин, 1,5 ГБ) не разрываются переносом. */
const NB = '\u00a0';

/** Дробное число с запятой: 1,5. */
const comma = (v: number, digits: number) => v.toFixed(digits).replace('.', ',');

export function ago(iso: string | null | undefined): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return 'только что';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}${NB}мин назад`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}${NB}ч назад`;
  const days = Math.round(h / 24);
  return `${days}${NB}${plural(days, 'день', 'дня', 'дней')} назад`;
}

export function uptime(sec: number): string {
  if (sec < 3600) return `${Math.round(sec / 60)}${NB}мин`;
  if (sec < 86_400) return `${Math.round(sec / 3600)}${NB}ч`;
  return `${Math.round(sec / 86_400)}${NB}сут.`;
}

export function gb(v: number): string {
  return v >= 100 ? String(Math.round(v)) : comma(v, 1);
}

/** Период оплаты словами: 1 - мес., 3 - 3 мес., 12 - год, 24 - 2 года. */
function periodLabel(months: number): string {
  if (months === 1) return 'мес.';
  if (months === 12) return 'год';
  if (months % 12 === 0) {
    const years = months / 12;
    return `${years}${NB}${plural(years, 'год', 'года', 'лет')}`;
  }
  return `${months}${NB}мес.`;
}

/** Знак валюты по коду; неизвестный код показывается как есть. */
const CURRENCY: Record<string, string> = { RUB: '\u20bd', EUR: '\u20ac', USD: '$' };

export function money(price: number | null, currency: string, months: number): string {
  if (price === null) return '';
  const sym = CURRENCY[currency] ?? currency;
  return `${price.toLocaleString('ru-RU')}${NB}${sym}/${periodLabel(months)}`;
}

/** Сумма в пересчёте на месяц, для сравнения серверов. */
export function perMonth(price: number | null, currency: string, months: number): string {
  if (price === null || months <= 1) return '';
  const sym = CURRENCY[currency] ?? currency;
  return `${(price / months).toLocaleString('ru-RU', { maximumFractionDigits: 0 })}${NB}${sym}/мес.`;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** День и месяц, год - только если не текущий: 22.10, 22.10.2025 (местное время). */
function dayMonth(d: Date): string {
  const dm = `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
  return d.getFullYear() === new Date().getFullYear() ? dm : `${dm}.${d.getFullYear()}`;
}

/** Дата и время для журналов: 03.10 21:15, в другом году - 03.10.2025 21:15. */
export function dateTime(iso: string): string {
  const d = new Date(iso);
  return `${dayMonth(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Полная дата: 03.10.2026 (местное время). */
export function dateFull(v: string | number | Date): string {
  const d = new Date(v);
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** Время по местным часам: 09:30. */
export function hm(v: string | number | Date): string {
  const d = new Date(v);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Час, заданный в UTC, по местным часам браузера (со смещением пояса, в том числе нецелым). */
export function utcHourLocal(utcHour: number): string {
  return hm(Date.UTC(2020, 0, 1, utcHour));
}

export function dateShort(iso: string | null): string {
  if (!iso) return '';
  return dayMonth(new Date(iso));
}

/** Срок по unix-времени в секундах: "ещё 12 дн", "истёк"; 0 - "без срока". */
export function expiresLabel(unix: number): string {
  if (!unix) return 'без срока';
  const days = Math.ceil((unix * 1000 - Date.now()) / 86_400_000);
  return days <= 0 ? 'истёк' : `ещё ${days}${NB}дн`;
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
const PAYMENT_SOON_DAYS = 2;

/** Платёж скоро или просрочен: не дальше PAYMENT_SOON_DAYS дней. */
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

/** "сегодня", "завтра", "через 2 дня". */
export function daysWord(days: number): string {
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${days}${NB}${plural(days, 'день', 'дня', 'дней')}`;
}

/** Версия агента "0.2.0+20260926.0145.abc1234" -> "0.2.0 (26.09 01:45)". */
export function agentVersionShort(v: string | null | undefined): string {
  if (!v) return '';
  const m = /^([^+]+)\+(\d{4})(\d{2})(\d{2})\.(\d{2})(\d{2})/.exec(v);
  if (!m) return v;
  return `${m[1]} (${m[4]}.${m[3]} ${m[5]}:${m[6]})`;
}

/** Байты в человеческий вид: 12 МБ, 1,2 ГБ. */
export function bytes(n: number): string {
  if (!n) return `0${NB}Б`;
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : comma(v, 1)}${NB}${units[i]}`;
}

/** Первая буква - прописная: для ошибки API (она со строчной), показанной не после двоеточия. */
export const cap = (s: string): string => (s ? s[0]?.toUpperCase() + s.slice(1) : s);
