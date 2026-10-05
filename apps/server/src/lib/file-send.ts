import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Раздача файла потоком, а не целиком в память на каждый запрос (в том числе на Range в
 * 1 байт): иначе полсотни запросов без входа уронили бы панель по памяти.
 * Range - один отрезок `bytes=a-b` / `bytes=a-`; неверный - 416.
 */
export function sendFile(req: FastifyRequest, reply: FastifyReply, file: string) {
  const size = statSync(file).size;
  reply.header('accept-ranges', 'bytes');
  reply.type('application/octet-stream');
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(String(range));
    const start = m ? Number(m[1]) : Number.NaN;
    const end = m?.[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
    if (!m || start >= size || start > end) {
      reply.header('content-range', `bytes */${size}`);
      return reply.code(416).send();
    }
    reply.header('content-range', `bytes ${start}-${end}/${size}`);
    reply.header('content-length', String(end - start + 1));
    return reply.code(206).send(createReadStream(file, { start, end }));
  }
  reply.header('content-length', String(size));
  return reply.send(createReadStream(file));
}

const sums = new Map<string, { mtimeMs: number; size: number; sha256: string }>();

/** sha256 файла с кэшем по времени изменения и размеру: не перечитывать 12 МБ на каждый запрос. */
export function fileSha256(file: string): Promise<string> {
  const st = statSync(file);
  const c = sums.get(file);
  if (c && c.mtimeMs === st.mtimeMs && c.size === st.size) return Promise.resolve(c.sha256);
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (d) => h.update(d))
      .on('error', reject)
      .on('end', () => {
        const sha256 = h.digest('hex');
        sums.set(file, { mtimeMs: st.mtimeMs, size: st.size, sha256 });
        resolve(sha256);
      });
  });
}

/** Лимит частоты для раздачи без входа: агент докачивает кусками в 4 потока - с запасом. */
export const downloadRateLimit = { rateLimit: { max: 120, timeWindow: '1 minute' } };
