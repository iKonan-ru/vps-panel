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

/** Сколько живёт короткая ссылка кнопки: кнопки старого уведомления работают неделю. */
export const REF_TTL_MS = 7 * 24 * 3600_000;

/** Хранилище коротких ссылок между перезапусками панели (BotStore). */
export interface RefStore {
  get<T>(kind: string, key: string): T | null;
  put(kind: string, key: string, value: unknown, ttlMs: number): void;
  keyOf(kind: string, value: unknown): string | null;
}

/**
 * Короткие ссылки на значения, которые не помещаются в callback_data. С хранилищем переживают
 * перезапуск панели; без него (тесты) - в памяти. Устаревшая ссылка - кнопка отвечает
 * "неактуально".
 */
export class Refs {
  private map = new Map<string, { value: string; at: number }>();

  constructor(
    private store: RefStore | null = null,
    private ttlMs = REF_TTL_MS,
    private max = 1000,
  ) {}

  put(value: string): string {
    if (this.store) {
      const key = this.store.keyOf('ref', value) ?? randomBytes(6).toString('base64url');
      this.store.put('ref', key, value, this.ttlMs);
      return key;
    }
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
    if (this.store) return this.store.get<string>('ref', key);
    const v = this.map.get(key);
    if (!v || Date.now() - v.at > this.ttlMs) return null;
    return v.value;
  }

  /** Значение-объект, сохранённое как JSON; null - ссылка устарела или испорчена. */
  json<T>(key: string): T | null {
    const raw = this.get(key);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
