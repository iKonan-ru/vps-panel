/**
 * Вывод команды для журнала: известные секреты (ответы-пароли, секретные поля доступов)
 * заменены, секрет в ссылках прокси (tg://proxy?...&secret=...) - тоже. Короткие значения не
 * трогаются: замена "1" испортила бы весь вывод.
 */
export function redactOutput(output: string, secrets: string[]): string {
  let out = output;
  for (const v of secrets) if (v.length >= 6) out = out.split(v).join('********');
  return out.replace(/([?&]secret=)[0-9A-Za-z_-]+/g, '$1********');
}
