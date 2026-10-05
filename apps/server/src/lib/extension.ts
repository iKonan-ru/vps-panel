import { readFileSync, statSync } from 'node:fs';
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
