/**
 * Вывод команды для журнала: известные секреты (ответы-пароли, секретные поля доступов)
 * заменены, секрет в ссылках прокси (tg://proxy?...&secret=...) и токен API, который печатает
 * установщик (3X-UI 3.10+: "API Token: ...") - тоже. Короткие значения не трогаются: замена
 * "1" испортила бы весь вывод.
 */
export function redactOutput(output: string, secrets: string[]): string {
  let out = output;
  for (const v of secrets) if (v.length >= 6) out = out.split(v).join('********');
  return out
    .replace(/([?&]secret=)[0-9A-Za-z_-]+/g, '$1********')
    .replace(/(API[ _-]?Token[ \t]*[:=][ \t]*)[\w.+/=-]+/gi, '$1********');
}
