import { describe, expect, it, vi } from 'vitest';
import { BUFFER_CHARS, type TermPeer, TermSessions } from '../src/lib/term-sessions.js';

function peer() {
  const sent: unknown[] = [];
  const closed: number[] = [];
  const p: TermPeer = { send: (o) => sent.push(o), close: (c) => closed.push(c) };
  return { p, sent, closed };
}

describe('сессии терминала', () => {
  it('уход браузера закрывает сессию только через время, возврат её подхватывает', () => {
    vi.useFakeTimers();
    const closeRemote = vi.fn();
    const ts = new TermSessions(closeRemote, 1000);
    const a = peer();
    const s = ts.create('sid1', 'srv', 'admin', a.p);
    ts.output(s, 'AAAA');
    ts.detach(s, a.p, false);
    vi.advanceTimersByTime(900);
    expect(closeRemote).not.toHaveBeenCalled();
    const b = peer();
    expect(ts.resumable('sid1', 'srv', 'admin')).toBe(s);
    ts.attach(s, b.p);
    expect(b.sent).toEqual([{ t: 'data', d: 'AAAA' }]);
    vi.advanceTimersByTime(5000);
    expect(closeRemote).not.toHaveBeenCalled();
    ts.detach(s, b.p, false);
    vi.advanceTimersByTime(1000);
    expect(closeRemote).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it('"Закрыть" закрывает сразу; чужой сервер и вход не подхватывают', () => {
    const closeRemote = vi.fn();
    const ts = new TermSessions(closeRemote, 1000);
    const a = peer();
    const s = ts.create('sid2', 'srv', 'admin', a.p);
    expect(ts.resumable('sid2', 'other', 'admin')).toBeNull();
    expect(ts.resumable('sid2', 'srv', 'other')).toBeNull();
    ts.detach(s, a.p, true);
    expect(closeRemote).toHaveBeenCalledTimes(1);
    ts.end(s);
    expect(ts.get('sid2')).toBeUndefined();
  });

  it('вторая вкладка вытесняет первую, отключение вытесненной сессию не трогает', () => {
    vi.useFakeTimers();
    const closeRemote = vi.fn();
    const ts = new TermSessions(closeRemote, 1000);
    const a = peer();
    const b = peer();
    const s = ts.create('sid3', 'srv', 'admin', a.p);
    ts.attach(s, b.p);
    expect(a.closed).toEqual([4010]);
    ts.detach(s, a.p, false);
    vi.advanceTimersByTime(5000);
    expect(closeRemote).not.toHaveBeenCalled();
    ts.output(s, 'BB');
    expect(b.sent).toEqual([{ t: 'data', d: 'BB' }]);
    vi.useRealTimers();
  });

  it('буфер хранит только последний вывод', () => {
    const ts = new TermSessions(() => {}, 1000);
    const a = peer();
    const s = ts.create('sid4', 'srv', 'admin', a.p);
    const big = 'x'.repeat(BUFFER_CHARS / 2);
    ts.output(s, big);
    ts.output(s, big);
    ts.output(s, 'tail');
    expect(s.size).toBeLessThanOrEqual(BUFFER_CHARS);
    expect(s.chunks.at(-1)).toBe('tail');
    expect(s.total).toBe(BUFFER_CHARS + 4);
  });
});
