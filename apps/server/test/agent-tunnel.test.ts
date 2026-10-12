import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { TunnelSocket, tunnelConnection } from '../src/lib/agent-tunnel.js';

/** Реестр-заглушка: запоминает запросы, open держит до команды теста. */
function fakeRegistry() {
  const calls: { method: string; params: Record<string, unknown> }[] = [];
  let stream: ((ch: string, chunk: string) => void) | undefined;
  let finishOpen: (() => void) | undefined;
  let failOpen: ((e: Error) => void) | undefined;
  const registry = {
    request: (
      _id: string,
      method: string,
      params: Record<string, unknown>,
      opts: { onStream?: (ch: string, chunk: string) => void },
    ) => {
      calls.push({ method, params });
      if (method === 'tunnel.open') {
        stream = opts.onStream;
        return new Promise<void>((r, j) => {
          finishOpen = r;
          failOpen = j;
        });
      }
      return Promise.resolve({ ok: true });
    },
  } as unknown as AgentRegistry;
  return {
    registry,
    calls,
    emit: (ch: string, chunk: string) => stream?.(ch, chunk),
    finish: () => finishOpen?.(),
    fail: () => failOpen?.(new Error('агент отключился')),
  };
}

describe('TunnelSocket', () => {
  it('записи до open копятся и уходят по порядку, данные агента читаются, конец - EOF', async () => {
    const f = fakeRegistry();
    const s = new TunnelSocket(f.registry, 's1', 2053);
    s.write('a');
    s.write('b');
    expect(f.calls.map((c) => c.method)).toEqual(['tunnel.open']);
    f.emit('log', 'open');
    s.write('c');
    const writes = f.calls.filter((c) => c.method === 'tunnel.write');
    expect(writes.map((w) => Buffer.from(String(w.params.data), 'base64').toString())).toEqual([
      'a',
      'b',
      'c',
    ]);
    expect(f.calls[0]?.params).toEqual({ id: s.id, port: 2053 });
    const got: Buffer[] = [];
    s.on('data', (d: Buffer) => got.push(d));
    f.emit('data', Buffer.from('ответ').toString('base64'));
    f.finish();
    await new Promise((r) => s.once('end', r));
    expect(Buffer.concat(got).toString()).toBe('ответ');
  });

  it('destroy закрывает поток на агенте', () => {
    const f = fakeRegistry();
    const s = new TunnelSocket(f.registry, 's1', 2053);
    s.destroy();
    expect(f.calls.map((c) => c.method)).toContain('tunnel.close');
  });

  // 3X-UI на сервере перезапустили при открытой панели - TLS поверх потока дописывал
  // close_notify в закрытый поток, 'error' без слушателя уронил процесс панели
  it('сервер закрыл поток посреди TLS - ни одной необработанной ошибки', async () => {
    const f = fakeRegistry();
    const tls = tunnelConnection(f.registry, 's1', 2053, true);
    f.emit('log', 'open');
    // мусор вместо ответа TLS и закрытие с той стороны
    f.emit('data', Buffer.from('not tls at all\r\n').toString('base64'));
    f.finish();
    await new Promise((r) => tls.once('close', r));
    tls.write('после закрытия');
    tls.end();
    await new Promise((r) => setTimeout(r, 50));
  });

  it('запись после закрытия с той стороны и сбой агента - без error', async () => {
    const f = fakeRegistry();
    const s = new TunnelSocket(f.registry, 's1', 2053);
    let errors = 0;
    s.on('error', () => errors++);
    f.emit('log', 'open');
    f.finish();
    s.resume();
    await new Promise((r) => s.once('end', r));
    s.write('x');
    s.end();
    const g = fakeRegistry();
    const t = new TunnelSocket(g.registry, 's1', 2053);
    t.on('error', () => errors++);
    g.fail();
    await new Promise((r) => t.once('close', r));
    expect(errors).toBe(0);
    expect(f.calls.filter((c) => c.method === 'tunnel.write')).toHaveLength(0);
  });
});
