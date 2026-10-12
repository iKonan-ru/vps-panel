import { promises as dns } from 'node:dns';
import { Socket } from 'node:net';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Проверка доступности сервера с панели до его добавления: DNS, TCP до порта
 * SSH, баннер sshd. Ничего не меняет, паролей не требует.
 */
export async function probeRoutes(app: FastifyInstance) {
  app.post('/api/probe', async (req) => {
    const { host, port } = z
      .object({
        host: z.string().min(1).max(253),
        port: z.number().int().min(1).max(65535).default(22),
      })
      .parse(req.body);
    const steps: { name: string; ok: boolean; detail: string; ms?: number }[] = [];

    let ip = host;
    const isIp = /^[\d.]+$|^[0-9a-f:]+$/i.test(host);
    if (!isIp) {
      const t = Date.now();
      try {
        const res = await dns.lookup(host, { all: true });
        ip = res[0]?.address ?? host;
        steps.push({
          name: 'DNS',
          ok: true,
          detail: res.map((r) => r.address).join(', '),
          ms: Date.now() - t,
        });
      } catch (e) {
        steps.push({
          name: 'DNS',
          ok: false,
          detail: `имя не найдено в DNS: ${(e as Error).message}`,
        });
        return { ok: false, steps };
      }
    } else {
      steps.push({ name: 'DNS', ok: true, detail: 'указан IP' });
    }

    const t = Date.now();
    const tcp = await connectAndBanner(ip, port, 7000);
    if (!tcp.ok) {
      steps.push({
        name: `TCP ${ip}:${port}`,
        ok: false,
        detail: tcp.error ?? 'нет ответа',
        ms: Date.now() - t,
      });
      steps.push({
        name: 'Подсказка',
        ok: false,
        detail: tcp.error?.includes('ECONNREFUSED')
          ? 'порт закрыт или sshd на нём не слушает: возможно, указан не тот порт SSH'
          : 'таймаут: сервер выключен, firewall блокирует входящие с адреса панели или указан не тот порт',
      });
      return { ok: false, steps };
    }
    steps.push({
      name: `TCP ${ip}:${port}`,
      ok: true,
      detail: 'соединение установлено',
      ms: Date.now() - t,
    });
    if (tcp.banner) {
      const isSsh = tcp.banner.startsWith('SSH-');
      steps.push({
        name: 'SSH',
        ok: isSsh,
        detail: isSsh ? tcp.banner : `на порту не sshd: \u00ab${tcp.banner.slice(0, 40)}\u00bb`,
      });
    } else {
      steps.push({
        name: 'SSH',
        ok: false,
        detail: 'порт открыт, но баннер SSH не пришёл за 3\u00a0с',
      });
    }
    return { ok: steps.every((s) => s.ok), steps };
  });
}

function connectAndBanner(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<{ ok: boolean; banner?: string; error?: string }> {
  return new Promise((resolve) => {
    const sock = new Socket();
    let settled = false;
    let banner = '';
    const done = (r: { ok: boolean; banner?: string; error?: string }) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () =>
      done(banner ? { ok: true, banner } : { ok: false, error: 'таймаут' }),
    );
    sock.once('error', (e: NodeJS.ErrnoException) =>
      done({ ok: false, error: e.code ?? e.message }),
    );
    sock.connect(port, host, () => {
      // Баннер sshd приходит сразу после подключения; ждём не больше 3 с.
      setTimeout(() => done({ ok: true, banner: banner.trim() }), 3000);
    });
    sock.on('data', (d: Buffer) => {
      banner += d.toString('latin1');
      if (banner.includes('\n')) done({ ok: true, banner: banner.split('\n')[0]?.trim() ?? '' });
    });
  });
}
