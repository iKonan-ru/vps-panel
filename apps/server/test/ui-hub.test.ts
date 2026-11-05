import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { UiHub } from '../src/lib/ui-hub.js';

class Tab extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  bufferedAmount = 0;
  sent: string[] = [];
  closed = 0;
  send(msg: string) {
    this.sent.push(msg);
  }
  close() {
    this.closed++;
  }
}

describe('рассылка UI', () => {
  it('медленную вкладку отключает, а не копит события в памяти', () => {
    const hub = new UiHub();
    const slow = new Tab();
    const fast = new Tab();
    slow.bufferedAmount = 2 * 1024 * 1024;
    hub.add(slow as never);
    hub.add(fast as never);
    hub.broadcast({ type: 'agents.rollout' });
    expect(slow.closed).toBe(1);
    expect(slow.sent).toEqual([]);
    expect(fast.sent).toHaveLength(1);
  });

  it('не принимает больше 64 вкладок', () => {
    const hub = new UiHub();
    for (let i = 0; i < 64; i++) hub.add(new Tab() as never);
    const extra = new Tab();
    hub.add(extra as never);
    expect(extra.closed).toBe(1);
    expect(hub.count).toBe(64);
  });
});
