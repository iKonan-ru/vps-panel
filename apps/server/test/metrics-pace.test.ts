import { EventEmitter } from 'node:events';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRegistry } from '../src/agents/registry.js';
import { type StatusCache, bindStateToDb, toSummary } from '../src/agents/state.js';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { FAST_METRICS_SEC, SLOW_AFTER_MS, startMetricsPace } from '../src/lib/metrics-pace.js';
import { UiHub } from '../src/lib/ui-hub.js';

/** Сокет агента: запросы панели - в sent, метрики агента - через reply(). */
class FakeAgent extends EventEmitter {
  sent: { method: string; params: { sec?: number } }[] = [];
  send(raw: string, cb?: (err?: Error) => void) {
    this.sent.push(JSON.parse(raw));
    cb?.();
  }
  close() {
    this.emit('close');
  }
  terminate() {
    this.close();
  }
  ping() {}
  reply(msg: Record<string, unknown>) {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
}
/** Вкладка браузера на /ws/ui. */
class FakeTab extends EventEmitter {
  readyState = 1;
  OPEN = 1;
  send() {}
}

const metrics = (cpu: number) => ({
  cpuPercent: cpu,
  memTotalMb: 1000,
  memUsedMb: 100,
  diskTotalGb: 10,
  diskUsedGb: 1,
  netRxBps: 0,
  netTxBps: 0,
  uptimeSec: 1,
  load1: 0,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('частота метрик агентов', () => {
  it('2 с, пока открыта вкладка; закрыли последнюю - через минуту 30 с; старым агентам - ничего', () => {
    vi.useFakeTimers();
    const reg = new AgentRegistry();
    const hub = new UiHub();
    const fresh = new FakeAgent();
    const old = new FakeAgent();
    reg.attach({ serverId: 's1', ws: fresh as never, methods: ['metrics.interval'] });
    reg.attach({ serverId: 's2', ws: old as never, methods: ['inventory.get'] });
    // online приходит после welcome (setImmediate): эти агенты подключились до запуска
    vi.advanceTimersByTime(0);
    startMetricsPace(reg, hub, { warn: () => {} });
    const intervals = (a: FakeAgent) =>
      a.sent.filter((m) => m.method === 'metrics.interval').map((m) => m.params.sec);

    const tab = new FakeTab();
    hub.add(tab as never);
    expect(intervals(fresh)).toEqual([FAST_METRICS_SEC]);
    expect(intervals(old)).toEqual([]);

    // вторая вкладка и перезагрузка первой - без лишних команд
    const tab2 = new FakeTab();
    hub.add(tab2 as never);
    tab.emit('close');
    expect(intervals(fresh)).toEqual([2]);

    // закрыли последнюю: не сразу, через минуту
    tab2.emit('close');
    vi.advanceTimersByTime(SLOW_AFTER_MS - 1000);
    expect(intervals(fresh)).toEqual([2]);
    vi.advanceTimersByTime(1000);
    expect(intervals(fresh)).toEqual([2, 30]);

    // открыли снова, подключился новый агент - ему тоже быстрая частота
    hub.add(new FakeTab() as never);
    const late = new FakeAgent();
    reg.attach({ serverId: 's3', ws: late as never, methods: ['metrics.interval'] });
    vi.advanceTimersByTime(1000);
    expect(intervals(late)).toEqual([2]);
    expect(intervals(fresh)).toEqual([2, 30, 2]);
  });

  it('свежие метрики - в памяти и в карточке, в базу - не чаще раза в 30 с', () => {
    vi.useFakeTimers();
    const db = createDb(':memory:');
    db.insert(servers)
      .values({ id: 's1', name: 's1', host: '1.1.1.1' } as never)
      .run();
    const reg = new AgentRegistry();
    bindStateToDb(reg, db, { info: () => {} });
    const ws = new FakeAgent();
    reg.attach({ serverId: 's1', ws: ws as never, methods: [] });
    const stored = () =>
      (db.select().from(servers).where(eq(servers.id, 's1')).get()?.statusCache as StatusCache)
        .metrics?.cpuPercent;
    const row = () => db.select().from(servers).where(eq(servers.id, 's1')).get();

    ws.reply({ type: 'metrics', metrics: metrics(10) });
    expect(stored()).toBe(10);
    vi.advanceTimersByTime(2000);
    ws.reply({ type: 'metrics', metrics: metrics(55) });
    expect(stored()).toBe(10);
    expect(reg.latestMetrics('s1')?.metrics.cpuPercent).toBe(55);
    const r = row();
    if (!r) throw new Error('нет сервера');
    expect(toSummary(r, reg).metrics?.cpuPercent).toBe(55);
    vi.advanceTimersByTime(30_000);
    ws.reply({ type: 'metrics', metrics: metrics(70) });
    expect(stored()).toBe(70);
  });
});
