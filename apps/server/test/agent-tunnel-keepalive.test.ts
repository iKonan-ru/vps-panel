import { Agent, type Server, createServer, request } from 'node:http';
import { type Socket, connect, createServer as createNetServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { TunnelSocket, tunnelConnection } from '../src/lib/agent-tunnel.js';
import { forwardHttp } from '../src/lib/panel-proxy.js';

/**
 * Реестр, который правда соединяет поток с портом на 127.0.0.1, как агент. lag - задержка
 * канала в каждую сторону (панель в РФ, серверы за границей).
 */
function bridgeRegistry(lag = 0) {
  const later = (f: () => void) => (lag ? setTimeout(f, lag) : f());
  const conns = new Map<string, Socket>();
  return {
    request: (
      _id: string,
      method: string,
      params: { id: string; port?: number; data?: string },
      opts: { onStream?: (ch: string, chunk: string) => void } = {},
    ) => {
      if (method === 'tunnel.open')
        return new Promise<void>((resolve, reject) => {
          const c = connect(params.port ?? 0, '127.0.0.1', () =>
            later(() => opts.onStream?.('log', 'open')),
          );
          conns.set(params.id, c);
          c.on('data', (d) => later(() => opts.onStream?.('data', d.toString('base64'))));
          c.on('close', () => later(resolve));
          c.on('error', (e) => later(() => reject(e)));
        });
      if (method === 'tunnel.write') {
        const c = conns.get(params.id);
        later(() => c?.writable && c.write(Buffer.from(params.data ?? '', 'base64')));
      }
      if (method === 'tunnel.close') conns.get(params.id)?.destroy();
      return Promise.resolve({ ok: true });
    },
  } as unknown as AgentRegistry;
}

/** Панель сервиса: ответ keep-alive, соединение закрывается через idleMs простоя. */
async function servicePanel(idleMs: number) {
  const raw = createNetServer((sock) => {
    let idle: NodeJS.Timeout | undefined;
    sock.on('data', () => {
      clearTimeout(idle);
      sock.write('HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: keep-alive\r\n\r\nok');
      idle = setTimeout(() => sock.destroy(), idleMs);
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => raw.listen(0, '127.0.0.1', r));
  return { raw, port: (raw.address() as { port: number }).port };
}

const closers: { close: () => void }[] = [];
afterEach(() => {
  for (const c of closers.splice(0)) c.close();
});

/** Прокси панели: forwardHttp с пулом туннелей, как в PanelProxy. */
async function proxyTo(port: number, lag: number) {
  const registry = bridgeRegistry(lag);
  const agent = new Agent({ keepAlive: true, maxSockets: 8, timeout: 60_000 });
  (agent as unknown as { createConnection: unknown }).createConnection = () =>
    tunnelConnection(registry, 's1', port, false);
  const errors: string[] = [];
  const front: Server = createServer((req, res) =>
    forwardHttp(req, res, { headers: {}, port, tls: false, agent }, (e) => errors.push(e.message)),
  );
  await new Promise<void>((r) => front.listen(0, '127.0.0.1', r));
  closers.push(front);
  return { front: (front.address() as { port: number }).port, errors, registry };
}

function get(port: number, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: '127.0.0.1', port, path: '/', method, agent: false }, (res) => {
      let b = '';
      res.on('data', (d) => {
        b += d;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
    });
    r.on('error', reject);
    r.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('прокси панели: туннели в пуле keep-alive', () => {
  it('панель закрыла простаивающее соединение - следующий запрос идёт новым', async () => {
    const p = await servicePanel(100);
    closers.push(p.raw);
    const { front } = await proxyTo(p.port, 0);
    expect((await get(front)).body).toBe('ok');
    await sleep(300);
    expect((await get(front)).body).toBe('ok');
  });

  // запрос уходит по соединению, которое панель уже закрыла, а весть о закрытии ещё идёт
  // через агента: без повтора - 502 "socket hang up"
  it('панель закрыла соединение, пока запрос шёл к ней по туннелю, - GET повторяется', async () => {
    const p = await servicePanel(300);
    closers.push(p.raw);
    const { front, errors } = await proxyTo(p.port, 150);
    expect((await get(front)).body).toBe('ok');
    await sleep(120);
    const r = await get(front);
    expect(r.status).toBe(200);
    expect(r.body).toBe('ok');
    expect(errors).toEqual([]);
  });

  it('POST не повторяется: обрыв - 502', async () => {
    const p = await servicePanel(300);
    closers.push(p.raw);
    const { front, errors } = await proxyTo(p.port, 150);
    expect((await get(front)).body).toBe('ok');
    await sleep(120);
    expect((await get(front, 'POST')).status).toBe(502);
    expect(errors).toEqual(['socket hang up']);
  });
});

describe('TunnelSocket: события и простой', () => {
  it('tunnel-open, а на закрытый порт - tunnel-fail с текстом ошибки', async () => {
    const p = await servicePanel(1000);
    const registry = bridgeRegistry(0);
    const ok = new TunnelSocket(registry, 's1', p.port);
    await new Promise((r) => ok.once('tunnel-open', r));
    ok.destroy();
    p.raw.close();
    await sleep(50);
    const bad = new TunnelSocket(registry, 's1', p.port);
    bad.on('error', () => undefined);
    const msg = await new Promise<string>((r) => bad.once('tunnel-fail', r));
    expect(msg).toMatch(/ECONNREFUSED/);
  });

  it('setTimeout: timeout после простоя, активность продлевает', async () => {
    const p = await servicePanel(1000);
    closers.push(p.raw);
    const s = new TunnelSocket(bridgeRegistry(0), 's1', p.port);
    let fired = 0;
    s.setTimeout(150, () => fired++);
    await sleep(100);
    s.write('GET / HTTP/1.1\r\n\r\n');
    await sleep(100);
    expect(fired).toBe(0);
    await sleep(150);
    expect(fired).toBe(1);
    s.destroy();
  });
});
