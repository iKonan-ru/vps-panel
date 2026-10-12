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

/**
 * Подписанное расширение Firefox в FILES_DIR/firefox (кладёт tools/sign-firefox.mjs):
 * updates.json - адрес обновлений в манифесте расширения, архивы vps-panel-proxy-<версия>.xpi.
 */
export const FIREFOX_FILE = /^(updates\.json|vps-panel-proxy-\d+(\.\d+){1,3}\.xpi)$/;

/**
 * Последний по версии подписанный архив Firefox в каталогах (lib/firefox.ts firefoxDirs: сначала
 * подписанные панелью, потом прежние): путь к файлу; нет - null.
 */
export function firefoxXpi(dirs: string[]): string | null {
  const all: { dir: string; name: string }[] = [];
  for (const dir of dirs) {
    try {
      for (const n of readdirSync(dir))
        if (n.endsWith('.xpi') && FIREFOX_FILE.test(n) && !all.some((x) => x.name === n))
          all.push({ dir, name: n });
    } catch {}
  }
  const names = all.map((x) => x.name);
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
  const top = all.find((x) => x.name === names[0]);
  return top ? join(top.dir, top.name) : null;
}
