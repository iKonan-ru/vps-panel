import { createReadStream } from 'node:fs';
import { createGunzip } from 'node:zlib';

/** manifest.json - несколько килобайт; больше - не наш архив. */
const MAX_MANIFEST = 1024 * 1024;

/**
 * manifest.json из корня архива копии (tar.gz, агент пишет его последним): поток распаковывается
 * и просматривается по заголовкам tar, данные остальных файлов пропускаются. Нет файла или
 * архив битый - null.
 */
export function readArchiveManifest(path: string): Promise<Record<string, unknown> | null> {
  return new Promise((resolve) => {
    const src = createReadStream(path);
    const gz = createGunzip();
    let buf: Buffer = Buffer.alloc(0);
    // сколько байт данных текущего файла ещё пропустить (с выравниванием до 512)
    let skip = 0;
    let want: number | null = null;
    let done = false;
    const finish = (v: Record<string, unknown> | null) => {
      if (done) return;
      done = true;
      src.destroy();
      gz.destroy();
      resolve(v);
    };
    gz.on('data', (chunk: Buffer) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (skip > 0) {
          const n = Math.min(skip, buf.length);
          buf = buf.subarray(n);
          skip -= n;
          if (skip > 0) return;
        }
        if (want !== null) {
          if (buf.length < want) return;
          try {
            const v = JSON.parse(buf.subarray(0, want).toString('utf8'));
            finish(v && typeof v === 'object' && !Array.isArray(v) ? v : null);
          } catch {
            finish(null);
          }
          return;
        }
        if (buf.length < 512) return;
        const h = buf.subarray(0, 512);
        buf = buf.subarray(512);
        // два нулевых блока - конец архива
        if (h.every((b) => b === 0)) {
          finish(null);
          return;
        }
        const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
        const size = Number.parseInt(
          h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0',
          8,
        );
        if (!Number.isFinite(size) || size < 0) {
          finish(null);
          return;
        }
        const type = String.fromCharCode(h[156] ?? 0);
        if (
          (name === 'manifest.json' || name === './manifest.json') &&
          (type === '0' || type === '\0')
        ) {
          if (size > MAX_MANIFEST) {
            finish(null);
            return;
          }
          want = size;
          continue;
        }
        skip = Math.ceil(size / 512) * 512;
      }
    });
    gz.on('end', () => finish(null));
    gz.on('error', () => finish(null));
    src.on('error', () => finish(null));
    src.pipe(gz);
  });
}
