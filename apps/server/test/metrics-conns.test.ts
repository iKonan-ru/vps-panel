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
    expect(MetricsSchema.parse(base).conns).toBeUndefined();
    expect(MetricsSchema.parse({ ...base, conns: { tcp: -1 } }).conns).toBeUndefined();
  });
});
