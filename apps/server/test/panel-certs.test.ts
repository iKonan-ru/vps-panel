import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { PanelCerts } from '../src/lib/panel-certs.js';

// адрес панели - IP: panelAddresses обходится без DNS, сервер с этим адресом - сервер панели
const PANEL_URL = 'https://203.0.113.10';

function make(naiveDomain?: string) {
  const db = createDb(':memory:');
  const inv = (domain?: string) => ({
    inventory: {
      services: domain
        ? [{ kind: 'naive', title: 'Браузер (naive)', ports: [], details: { domain } }]
        : [],
    },
  });
  db.insert(servers)
    .values([
      { id: 'p', name: 'Panel', host: '203.0.113.10', statusCache: inv(naiveDomain) },
      { id: 'o', name: 'Other', host: '198.51.100.7', statusCache: inv('other.example.com') },
    ] as never)
    .run();
  return new PanelCerts(db, PANEL_URL);
}

describe('сертификаты сервисов на сервере панели', () => {
  it('сервер панели - по адресу панели', async () => {
    const c = make();
    expect(await c.isPanelHost('203.0.113.10')).toBe(true);
    expect(await c.isPanelHost('198.51.100.7')).toBe(false);
  });

  it('разрешено: имя от команды установки и имя прокси сервера панели', async () => {
    const c = make('proxy.example.com');
    expect(await c.allowed('proxy.example.com')).toBe(true);
    // прокси другого сервера сертификат выпускает сам - Caddy панели тут ни при чём
    expect(await c.allowed('other.example.com')).toBe(false);
    expect(await c.allowed('new.example.com')).toBe(false);
    c.allow('New.Example.com ');
    expect(await c.allowed('new.example.com')).toBe(true);
  });

  it('запросы на эти имена панель не обслуживает', async () => {
    const c = make('proxy.example.com');
    expect(c.isCertHost('proxy.example.com')).toBe(false);
    await c.refresh();
    expect(c.isCertHost('proxy.example.com')).toBe(true);
    expect(c.isCertHost('PROXY.example.com:443')).toBe(true);
    c.allow('new.example.com');
    expect(c.isCertHost('new.example.com')).toBe(true);
    for (const h of [
      'panel.example.com',
      'other.example.com',
      'panel:3000',
      '[::1]:3000',
      undefined,
    ])
      expect(c.isCertHost(h)).toBe(false);
  });
});
