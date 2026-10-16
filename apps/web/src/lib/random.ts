/** Буквы и цифры без похожих (0/O, 1/l/I): пароль можно прочитать и переписать. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Случайная строка из букв и цифр - криптостойкий генератор браузера. */
export function randomToken(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
