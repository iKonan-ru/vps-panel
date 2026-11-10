import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
import { cascadeClientEmail } from '../src/lib/cascades.js';
import { labelConns } from '../src/lib/conn-labels.js';

describe('подписи пользователей xray в метриках', () => {
  it('клиент - по имени, служебный клиент каскада - вход, чужое имя от агента отбрасывается', async () => {
    const db = createDb(':memory:');
    db.insert(servers)
      .values({ id: 'exit', name: 'NetCore', host: '198.51.100.1' } as never)
      .run();
    db.insert(servers)
      .values({ id: 'entry', name: 'Kappa', host: '198.51.100.2' } as never)
      .run();
    db.insert(gclients)
      .values({ id: 'g', name: 'Анна', token: 't', slug: 's' } as never)
      .run();
    db.insert(gclientBindings)
      .values({ id: 'b', clientId: 'g', serverId: 'exit', service: 'xui', ref: 'anna-1' } as never)
      .run();
    const m = {
      cpuPercent: 0,
      memTotalMb: 1,
      memUsedMb: 1,
      diskTotalGb: 1,
      diskUsedGb: 1,
      netRxBps: 0,
      netTxBps: 0,
      uptimeSec: 1,
      load1: 0,
      conns: {
        tcp: 5,
        awg: 0,
        top: [
          { ref: 'anna-1', conns: 3, ips: 1, name: 'подмена' },
          { ref: cascadeClientEmail('entry'), conns: 2, ips: 1 },
          { ref: 'unknown', conns: 1, ips: 1, name: 'подмена' },
        ],
      },
    };
    const top = labelConns(db, 'exit', m)?.conns?.top;
    expect(top?.[0]).toMatchObject({ name: 'Анна', kind: 'client' });
    expect(top?.[1]).toMatchObject({ name: 'Kappa', kind: 'cascade' });
    expect(top?.[2]?.name).toBeUndefined();
  });
});
