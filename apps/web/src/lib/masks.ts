/** Фильтры ввода: оставляют в строке только допустимые символы. */

/** Целое число без знака (порты, количества). */
export function digitsOnly(v: string): string {
  return v.replace(/\D+/g, '');
}

/** Сумма: цифры и один разделитель дробной части, не больше двух знаков после него. */
export function moneyMask(v: string): string {
  const cleaned = v.replace(/[^\d.,]/g, '').replace(',', '.');
  const [int = '', ...rest] = cleaned.split('.');
  const frac = rest.join('').slice(0, 2);
  return rest.length > 0 ? `${int}.${frac}` : int;
}

/** Целое в границах, пустая строка допустима. */
export function clampInt(v: string, min: number, max: number): string {
  const d = digitsOnly(v);
  if (!d) return '';
  return String(Math.min(max, Math.max(min, Number(d))));
}

/** Код 2FA: 6 цифр, либо резервный код (буквы и цифры, до 12). */
export function codeMask(v: string): string {
  return v.replace(/[^0-9a-zA-Z]/g, '').slice(0, 12);
}

/** Границы для полей даты: браузер не даст ввести год из 5 цифр. */
export const DATE_MIN = '2000-01-01';
export const DATE_MAX = '2099-12-31';
