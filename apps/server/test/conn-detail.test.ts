import type { ConnsListSnapshot } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
import { cascadeClientEmail } from '../src/lib/cascades.js';
import { buildConns, portLabel } from '../src/lib/conn-detail.js';

const services = [
  { kind: 'xui' as const, title: '3X-UI', ports: ['2053/tcp panel', '8443/tcp XHTTP'] },
];

describe('подключения сервера по адресам', () => {
  it('клиент, вход каскада, сервер, сервер панели и неопознанный адрес', () => {
    const db = createDb(':memory:');
    db.insert(servers)
      .values({ id: 'exit', name: 'NetCore', host: '198.51.100.1' } as never)
      .run();
    db.insert(servers)
      .values({ id: 'entry', name: 'Kappa', host: '198.51.100.2' } as never)
      .run();
    db.insert(servers)
      .values({ id: 'other', name: 'SkyHost', host: '198.51.100.3' } as never)
      .run();
    db.insert(gclients)
      .values({ id: 'g', name: 'Анна', token: 't', slug: 's' } as never)
      .run();
    db.insert(gclientBindings)
      .values({ id: 'b', clientId: 'g', serverId: 'exit', service: 'xui', ref: 'anna-1' } as never)
      .run();
    const snap: ConnsListSnapshot = {
      at: 1_759_830_000_000,
      listeners: [{ port: 8443, process: 'xray', conns: 9, ips: 5 }],
      addrs: [
        {
          ip: '203.0.113.1',
          conns: 5,
          ports: [{ port: 8443, conns: 5 }],
          users: [cascadeClientEmail('entry')],
        },
        { ip: '203.0.113.2', conns: 2, ports: [{ port: 8443, conns: 2 }], users: ['anna-1'] },
        { ip: '198.51.100.3', conns: 1, ports: [{ port: 8443, conns: 1 }], users: [] },
        { ip: '192.0.2.10', conns: 1, ports: [{ port: 8443, conns: 1 }], users: [] },
        { ip: '203.0.113.9', conns: 3, ports: [{ port: 443, conns: 3 }], users: ['manual-x'] },
      ],
      awg: [],
      truncated: false,
      errors: {},
    };
    const v = buildConns(db, 'exit', snap, {
      services,
      panelIps: ['192.0.2.10'],
      clients: 1,
    });
    const by = Object.fromEntries(v.addrs.map((a) => [a.ip, a]));
    expect(by['203.0.113.1']).toMatchObject({ kind: 'cascade', name: 'Kappa' });
    expect(by['203.0.113.2']).toMatchObject({ kind: 'client', name: 'Анна' });
    expect(by['198.51.100.3']).toMatchObject({ kind: 'server', name: 'SkyHost' });
    expect(by['192.0.2.10']).toMatchObject({ kind: 'server', name: 'сервер панели' });
    expect(by['203.0.113.9']).toMatchObject({ kind: 'client', name: 'manual-x' });
    expect(v.addrs.at(0)?.ports[0]?.label).toBe('3X-UI XHTTP');
    expect(v).toMatchObject({ conns: 12, addresses: 5, clients: 1 });
    expect(portLabel(services, 1)).toBe('');
  });
});
