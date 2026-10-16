import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Версия расширения Chrome из apps/extension/manifest.json: её получают
 * расширения в подписке и предлагают обновиться, если у них старее. Читается заново, только если
 * файл изменился; нет файла - null (тогда подписка о версии молчит).
 */
let cache: { dir: string; mtime: number; version: string | null } | null = null;

export function extensionVersion(dir: string): string | null {
  const file = join(dir, 'manifest.json');
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    return null;
  }
  if (cache && cache.dir === dir && cache.mtime === mtime) return cache.version;
  let version: string | null = null;
  try {
    const v = (JSON.parse(readFileSync(file, 'utf8')) as { version?: unknown }).version;
    version = typeof v === 'string' && /^\d+(\.\d+){0,3}$/.test(v) ? v : null;
  } catch {
    version = null;
  }
  cache = { dir, mtime, version };
  return version;
}

/** Подписанное расширение Firefox: updates.json и архивы vps-panel-proxy-<версия>.xpi. */
export const FIREFOX_FILE = /^(updates\.json|vps-panel-proxy-\d+(\.\d+){1,3}\.xpi)$/;

/** Самый новый по версии подписанный архив Firefox в каталоге; нет - null. */
export function firefoxXpi(dir: string): string | null {
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.xpi') && FIREFOX_FILE.test(n));
  } catch {
    return null;
  }
  const ver = (n: string) =>
    n
      .replace(/^vps-panel-proxy-|\.xpi$/g, '')
      .split('.')
      .map(Number);
  names.sort((a, b) => {
    const x = ver(a);
    const y = ver(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (y[i] ?? 0) - (x[i] ?? 0);
      if (d) return d;
    }
    return 0;
  });
  return names[0] ? join(dir, names[0]) : null;
}
