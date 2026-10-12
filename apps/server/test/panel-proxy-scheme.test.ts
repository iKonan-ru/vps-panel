import { type Server, createServer } from 'node:http';
import { type Socket, connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { PanelProxy, tlsMismatch } from '../src/lib/panel-proxy.js';

/** Реестр, который соединяет поток туннеля с портом на 127.0.0.1, как агент. */
function bridgeRegistry() {
  const conns = new Map<string, Socket>();
  return {
    isOnline: () => true,
    supports: () => true,
    request: (
      _id: string,
      method: string,
      params: { id: string; port?: number; data?: string },
      opts: { onStream?: (ch: string, chunk: string) => void } = {},
    ) => {
      if (method === 'tunnel.open')
        return new Promise<void>((resolve, reject) => {
          const c = connect(params.port ?? 0, '127.0.0.1', () => opts.onStream?.('log', 'open'));
          conns.set(params.id, c);
          c.on('data', (d) => opts.onStream?.('data', d.toString('base64')));
          c.on('close', () => resolve());
          c.on('error', (e) => reject(e));
        });
      if (method === 'tunnel.write') {
        const c = conns.get(params.id);
        if (c?.writable) c.write(Buffer.from(params.data ?? '', 'base64'));
      }
      if (method === 'tunnel.close') conns.get(params.id)?.destroy();
      return Promise.resolve({ ok: true });
    },
  } as unknown as AgentRegistry;
}

let panel: Server;
let port = 0;
const log = { warn: () => undefined, info: () => undefined };

beforeAll(async () => {
  // 3X-UI 3.10 на 127.0.0.1: сертификат в настройках есть, а отвечает обычным HTTP
  panel = createServer((_req, res) => res.writeHead(200).end('ok'));
  await new Promise<void>((r) => panel.listen(0, '127.0.0.1', r));
  port = (panel.address() as { port: number }).port;
});
afterAll(() => panel.close());

describe('панель сервиса: схема не та, что в снимке', () => {
  it('признаки: TLS к HTTP-порту и HTTP к TLS-порту', () => {
    expect(tlsMismatch(true, 'write EPROTO ...:wrong version number:...')).toBe(true);
    expect(tlsMismatch(true, 'connect ECONNREFUSED')).toBe(false);
    expect(tlsMismatch(false, 400)).toBe(true);
    expect(tlsMismatch(false, 404)).toBe(false);
  });

  it('снимок говорит https, панель отвечает http - проверка проходит, схема запоминается', async () => {
    const db = createDb(':memory:');
    const inventory = {
      services: [
        {
          kind: 'xui',
          title: '3X-UI',
          ports: [],
          panelUrl: `https://203.0.113.10:${port}/base/`,
        },
      ],
    };
    db.insert(servers)
      .values({
        id: 's1',
        name: 'Helsinki',
        host: '203.0.113.10',
        statusCache: { inventory },
      } as never)
      .run();
    const proxy = new PanelProxy(db, bridgeRegistry(), 'panel.example', 'x'.repeat(32), log);
    expect((await proxy.target('helsinki-xui'))?.tls).toBe(true);
    const r = await proxy.probe('helsinki-xui');
    expect(r.ok, r.error).toBe(true);
    expect((await proxy.target('helsinki-xui'))?.tls).toBe(false);
    // повторная проверка - сразу по найденной схеме
    expect((await proxy.probe('helsinki-xui')).ok).toBe(true);
  });
});
