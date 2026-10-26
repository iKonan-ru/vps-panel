import { tgSpan, tgWhen } from '../../lib/telegram.js';
import { cb } from '../codec.js';

/**
 * Экраны бота: чистые функции "данные API - текст и кнопки". Тексты - HTML Telegram, всё
 * пришедшее из данных - через esc(). В исходниках только клавиатурные символы: значки, тире и
 * кавычки - кодами. Здесь - общее для всех экранов.
 */

export interface Btn {
  text: string;
  data?: string;
  url?: string;
  /** кнопка копирования текста (до 256 символов) */
  copy?: string;
}
export interface Screen {
  text: string;
  kb: Btn[][];
}
export interface Ctx {
  now: number;
  /** адрес панели для кнопок "Открыть в панели" (только https) */
  panelUrl: string;
  /** короткая ссылка на значение, которое не помещается в callback_data */
  ref: (value: string) => string;
}

export const NB = '\u00a0';
export const DASH = '\u00a0\u2014 ';
export const SEP = ' \u00b7 ';
export const I = {
  ok: '\u{1F7E2}',
  bad: '\u{1F534}',
  warn: '\u{1F7E1}',
  none: '\u26aa',
  done: '\u2705',
  fail: '\u274c',
  run: '\u23f3',
  back: '\u2190',
  prev: '\u2039',
  next: '\u203a',
  user: '\u{1F464}',
};
export const q = (s: string) => `\u00ab${s}\u00bb`;

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Ровно 1,2 ГБ: дробь через запятую, без лишнего нуля. */
export function num(v: number, digits = 1): string {
  return (Math.round(v * 10 ** digits) / 10 ** digits).toString().replace('.', ',');
}

/** "5 мин назад"; давнее - временем по Москве. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'только что';
  if (ms < 24 * 3600_000) return `${tgSpan(ms)} назад`;
  return tgWhen(iso, now);
}

/** Строка не длиннее max символов: лишнее - многоточием. */
export function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

/** Флаг страны по коду ISO из двух букв. */
export function flag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const up = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}

/** Название страны по-русски по коду ISO. */
export function country(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Кнопка "Открыть в панели": Telegram принимает только настоящие адреса, локальные - нет. */
export function panelLink(c: Ctx, path: string): Btn[] {
  if (!c.panelUrl.startsWith('https://')) return [];
  try {
    return [{ text: 'Открыть в панели', url: new URL(path, c.panelUrl).href }];
  } catch {
    return [];
  }
}

/** Кнопка возврата к карточке сервера. */
export function toServer(s: { id: string; name: string }): Btn {
  return { text: `${I.back} ${cut(s.name, 20)}`, data: cb('sv', s.id) };
}

/** Размер: 1,2 ГБ, 340 МБ. */
export function size(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${num(bytes / 1024 ** 3)}${NB}ГБ`;
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))}${NB}МБ`;
}

/** Хвост вывода: целые строки, не длиннее max символов. */
export function tail(out: string, max = 3000): string {
  const t = out.replace(/\r/g, '').replace(/\n+$/, '');
  if (t.length <= max) return t;
  const s = t.slice(-max);
  const nl = s.indexOf('\n');
  return nl >= 0 && nl < s.length - 1 ? s.slice(nl + 1) : s;
}

/** Последняя содержательная строка вывода: причина ошибки без всего вывода. */
export function lastLine(out: string): string {
  const lines = out
    .replace(/\r/g, '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return cut(lines.at(-1) ?? '', 300);
}

/** Кнопки по n в ряд. */
export function grid(btns: Btn[], n: number): Btn[][] {
  const out: Btn[][] = [];
  for (let i = 0; i < btns.length; i += n) out.push(btns.slice(i, i + n));
  return out;
}
