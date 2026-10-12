import { describe, expect, it } from 'vitest';
import { type ReachTarget, apply, inboundTargets, level } from '../src/lib/ru-reach.js';

describe('доступность из России', () => {
  it('цели inbound-ов: свои включённые поверх TCP, Reality и TLS - с SNI', () => {
    const list = [
      {
        id: 1,
        remark: 'VLESS',
        enable: true,
        protocol: 'vless',
        port: 443,
        streamSettings: JSON.stringify({
          network: 'tcp',
          security: 'reality',
          realitySettings: { serverNames: ['example.com'] },
        }),
      },
      {
        id: 2,
        remark: 'XHTTP',
        enable: true,
        protocol: 'vless',
        port: 8443,
        streamSettings: {
          network: 'xhttp',
          security: 'tls',
          tlsSettings: { serverName: 'a.example.com' },
        },
      },
      {
        id: 3,
        enable: true,
        protocol: 'vless',
        port: 9000,
        streamSettings: { network: 'tcp', security: 'none' },
      },
      { id: 4, enable: false, protocol: 'vless', port: 9001, streamSettings: { network: 'tcp' } },
      {
        id: 5,
        enable: true,
        protocol: 'vless',
        port: 9002,
        nodeId: 3,
        streamSettings: { network: 'tcp' },
      },
      { id: 6, enable: true, protocol: 'vless', port: 9003, streamSettings: { network: 'kcp' } },
      { id: 7, enable: true, protocol: 'wireguard', port: 51820, streamSettings: {} },
    ];
    expect(inboundTargets(list, '1.2.3.4')).toEqual([
      {
        key: 'xui:1',
        title: '3X-UI VLESS',
        host: '1.2.3.4',
        port: 443,
        kind: 'tls',
        sni: 'example.com',
      },
      {
        key: 'xui:2',
        title: '3X-UI XHTTP',
        host: '1.2.3.4',
        port: 8443,
        kind: 'tls',
        sni: 'a.example.com',
      },
      { key: 'xui:3', title: '3X-UI #3', host: '1.2.3.4', port: 9000, kind: 'tcp' },
    ]);
  });

  it('уведомление - не виден вторую проверку подряд и снова виден; частично - не сбой', () => {
    const t: ReachTarget = {
      key: 'ip',
      title: 'Адрес сервера',
      kind: 'tcp',
      port: 22,
      percent: null,
      total: 0,
      ok: 0,
      errors: [],
      checkedAt: null,
      history: [],
      badStreak: 0,
      notified: false,
      source: 'agent',
    };
    const at = '2026-10-12T00:00:00Z';
    const r = (ok: number) => ({ percent: ok * 10, total: 10, ok, errors: ['timeout'], at });
    expect(apply(t, r(1))).toBeNull();
    expect(apply(t, r(2))?.text).toMatch(/не виден из России: дошли 2 из 10/);
    expect(apply(t, r(1))).toBeNull();
    expect(apply(t, r(6))).toBeNull();
    expect(t.badStreak).toBe(0);
    expect(apply(t, r(9))).toMatchObject({
      back: true,
      text: expect.stringMatching(/снова виден/),
    });
    expect(apply(t, r(10))).toBeNull();
    expect(t.history).toHaveLength(6);
    expect([level(null), level(49.9), level(50), level(80)]).toEqual([
      null,
      'bad',
      'partial',
      'ok',
    ]);
  });
});
