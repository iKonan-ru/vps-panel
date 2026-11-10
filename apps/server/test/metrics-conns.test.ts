import { MetricsSchema } from '@vps/protocol';
import { describe, expect, it } from 'vitest';

const base = {
  cpuPercent: 1,
  memTotalMb: 1,
  memUsedMb: 1,
  diskTotalGb: 1,
  diskUsedGb: 1,
  netRxBps: 0,
  netTxBps: 0,
  uptimeSec: 1,
  load1: 0,
};

describe('метрики: подключения клиентов', () => {
  it('агент со счётчиком - подключения доходят, без него и с мусором - нет', () => {
    expect(MetricsSchema.parse({ ...base, conns: { tcp: 7, awg: 2 } }).conns).toEqual({
      tcp: 7,
      awg: 2,
    });
    const full = { tcp: 3, ips: 2, awg: 0, ports: [{ port: 443, conns: 3, ips: 2 }] };
    expect(MetricsSchema.parse({ ...base, conns: full }).conns).toEqual(full);
    expect(MetricsSchema.parse(base).conns).toBeUndefined();
    expect(MetricsSchema.parse({ ...base, conns: { tcp: -1 } }).conns).toBeUndefined();
  });
});
