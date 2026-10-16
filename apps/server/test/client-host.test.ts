import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { HOSTNAME_RE, checkClientHost, clientHost } from '../src/lib/client-host.js';

describe('адрес для клиентов', () => {
  it('имя - если задано, иначе IP сервера', () => {
    expect(clientHost({ host: '203.0.113.1', clientHost: null })).toBe('203.0.113.1');
    expect(clientHost({ host: '203.0.113.1', clientHost: 'srv.example.com' })).toBe(
      'srv.example.com',
    );
  });

  it('только имена; IP и мусор отклоняются без запроса в DNS', async () => {
    expect(HOSTNAME_RE.test('srv.example.com')).toBe(true);
    expect(HOSTNAME_RE.test('a-b.c-d.example.ru')).toBe(true);
    for (const bad of [
      'srv',
      '203.0.113.1',
      'srv..example.com',
      '-x.example.com',
      'srv.example.com;rm',
    ])
      expect((await checkClientHost(bad, '203.0.113.1')).ok).toBe(false);
  });

  it('новая база и старая получают столбец client_host', () => {
    const db = createDb(':memory:');
    db.insert(servers)
      .values({ id: 's', name: 's', host: 'h', clientHost: 'srv.example.com' } as never)
      .run();
    expect(db.select().from(servers).get()?.clientHost).toBe('srv.example.com');
  });
});

describe('ссылка OpenFlux', () => {
  it('direct - на адрес для клиентов, без имени - на IP', async () => {
    const { openfluxLink } = await import('../src/lib/client-host.js');
    const reg = {
      request: async <T>(_id: string, _op: string, p: unknown) =>
        ({ link: `openflux://${(p as { host: string }).host}` }) as T,
    };
    const row = { id: 's', host: '203.0.113.1', clientHost: 'srv.example.com' };
    expect((await openfluxLink(reg, row, 'main', 'x')).link).toBe('openflux://srv.example.com');
    expect((await openfluxLink(reg, { ...row, clientHost: null }, 'main', 'x')).link).toBe(
      'openflux://203.0.113.1',
    );
  });
});
