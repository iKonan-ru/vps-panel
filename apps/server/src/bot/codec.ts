import { randomBytes } from 'node:crypto';

/** Предел callback_data у Telegram, байт. */
export const CB_MAX = 64;

/**
 * callback_data кнопки: "операция:аргумент:...". id панели (base64url) двоеточий не содержат;
 * длинное или произвольное (имя тега) - короткой ссылкой Refs.
 */
export function cb(op: string, ...args: (string | number)[]): string {
  const s = [op, ...args].join(':');
  if (Buffer.byteLength(s) > CB_MAX) throw new Error(`callback_data длиннее ${CB_MAX} байт: ${op}`);
  return s;
}

export function parseCb(data: string): { op: string; args: string[] } {
  const [op = '', ...args] = data.split(':');
  return { op, args };
}

/**
 * Короткие ссылки на значения, которые не помещаются в callback_data. Живут в памяти сутки:
 * после перезапуска панели кнопка с такой ссылкой отвечает "неактуально".
 */
export class Refs {
  private map = new Map<string, { value: string; at: number }>();

  constructor(
    private ttlMs = 24 * 3600_000,
    private max = 1000,
  ) {}

  put(value: string): string {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (now - v.at > this.ttlMs) this.map.delete(k);
      else if (v.value === value) {
        v.at = now;
        return k;
      }
    }
    while (this.map.size >= this.max) {
      const first = this.map.keys().next().value;
      if (first === undefined) break;
      this.map.delete(first);
    }
    const key = randomBytes(6).toString('base64url');
    this.map.set(key, { value, at: now });
    return key;
  }

  get(key: string): string | null {
    const v = this.map.get(key);
    if (!v || Date.now() - v.at > this.ttlMs) return null;
    return v.value;
  }
}
