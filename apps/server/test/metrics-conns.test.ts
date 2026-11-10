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

describe('метрики: клиенты на связи', () => {
  it('агент со счётчиком - числа доходят, без него и с мусором - нет', () => {
    const full = { clients: 3, ips: 2, awg: 1 };
    expect(MetricsSchema.parse({ ...base, conns: full }).conns).toEqual(full);
    expect(MetricsSchema.parse({ ...base, conns: { ips: 2, awg: 0 } }).conns).toEqual({
      ips: 2,
      awg: 0,
    });
    expect(MetricsSchema.parse(base).conns).toBeUndefined();
    expect(MetricsSchema.parse({ ...base, conns: { awg: -1 } }).conns).toBeUndefined();
  });
});
