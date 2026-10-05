import type { Service } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { standardCells } from '../src/lib/standard.js';

const svc = (kind: Service['kind'], extra: Partial<Service> = {}): Service => ({
  kind,
  title: kind,
  ports: [],
  ...extra,
});

describe('standardCells', () => {
  it('полный набор - всё ok', () => {
    const c = standardCells({
      services: [
        svc('xui', {
          version: '3.8.5',
          details: {
            inbounds: [
              { port: 443, protocol: 'vless', network: 'tcp', remark: 'reality' },
              { port: 8443, protocol: 'vless', network: 'xhttp', remark: 'xhttp' },
            ],
            remoteNodes: 0,
          },
        }),
        svc('mtproxyl', { version: '1.6.30', panelUrl: 'https://x' }),
        svc('amnezia'),
        svc('wdtt'),
        svc('openflux', {
          version: '1.2.0',
          details: { channels: [{ channel: 'main' }, { channel: 'vp-1' }], autoupdate: true },
        }),
        svc('naive', { details: { domain: 'hoster.example.com', down: false } }),
      ],
      awg: [
        { container: 'amnezia-awg2', version: '3.1', state: 'running' },
        { container: 'amnezia-awg2-42508', version: '2.0', state: 'running' },
      ],
      updates: [],
    });
    expect(Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v.state]))).toEqual({
      xui: 'ok',
      mtproxyl: 'ok',
      'awg-3.1': 'ok',
      'awg-2.0': 'ok',
      wdtt: 'ok',
      openflux: 'ok',
      naive: 'ok',
    });
    expect(c.naive.text).toBe('hoster.example.com');
    expect(c.openflux.text).toBe('1.2.0, каналов 2');
    expect(c.xui.text).toBe('3.8.5, inbound-ов 2');
    expect(c.mtproxyl.text).toBe('1.6.30, с панелью');
    expect(c['awg-2.0'].text).toBe('amnezia-awg2-42508');
  });

  it('отклонения и недостающее', () => {
    const c = standardCells({
      services: [
        svc('xui', { version: '3.8.5', details: { inbounds: null, remoteNodes: 5 } }),
        svc('mtproxyl', { version: '1.6.30' }),
        svc('amnezia'),
        svc('openflux', {
          version: '1.2.0',
          details: {
            channels: [],
            autoupdate: false,
            down: true,
            downReason: 'канал main: failed',
          },
        }),
      ],
      awg: [{ container: 'amnezia-awg2', version: '3.1', state: 'exited' }],
      updates: [
        {
          kind: 'mtproxyl-panel',
          title: 'MTProxyL: веб-панель',
          current: '1.2.12',
          latest: '1.2.13',
        },
      ],
    });
    expect(c.openflux).toMatchObject({
      state: 'warn',
      hint: 'канал main: failed, автообновление ядра выключено',
    });
    expect(c.xui).toMatchObject({ state: 'warn' });
    expect(c.xui.hint).toContain('нет своих inbound-ов');
    expect(c.xui.hint).toContain('узлов группы 3X-UI: 5');
    expect(c.mtproxyl).toMatchObject({ state: 'warn' });
    expect(c.mtproxyl.hint).toContain('1.2.12 -> 1.2.13');
    expect(c['awg-3.1']).toMatchObject({ state: 'warn', hint: 'не запущен: amnezia-awg2' });
    expect(c['awg-2.0'].state).toBe('missing');
    expect(c.wdtt.state).toBe('missing');
  });

  it('контейнеры AWG есть, а опроса не было - версия неизвестна', () => {
    const c = standardCells({ services: [svc('amnezia')], awg: null, updates: [] });
    expect(c['awg-3.1'].state).toBe('unknown');
    expect(standardCells({ services: [], awg: null, updates: [] })['awg-3.1'].state).toBe(
      'missing',
    );
  });
});
