import type { ReachTarget, ServerReach } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { apply, inboundTargets, level } from '../src/lib/ru-reach.js';

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
    expect(t.rtt).toBeUndefined();
    apply(t, { ...r(10), at: '2026-10-12T00:30:00Z', rtt: 46.38 });
    expect(t.rtt).toBe(46.4);
    expect(t.history.at(-1)).toEqual({
      at: '2026-10-12T00:30:00Z',
      percent: 100,
      total: 10,
      rtt: 46.4,
    });
    // ответ агента без задержки: у цели её нет, точка без rtt
    apply(t, { ...r(10), at: '2026-10-12T01:00:00Z' });
    expect(t.rtt).toBeUndefined();
    expect(t.history.at(-1)).not.toHaveProperty('rtt');
    expect([level(null), level(49.9), level(50), level(80)]).toEqual([
      null,
      'bad',
      'partial',
      'ok',
    ]);
  });
});

describe('ошибки Globalping', () => {
  it('вместо обрезанного JSON - причина и что делать', async () => {
    const { reachError } = await import('../src/lib/ru-reach.js');
    const raw =
      'Globalping ответил 401: { "error": { "type": "unauthorized", "message": "Unauthorized." }, "links": { "documentation": "https://globalping.io/docs/api.globalping.io#p';
    expect(reachError(raw)).toMatch(/не принял токен/);
    expect(
      reachError(
        'Globalping ответил 400: {"error":{"type":"validation_error","message":"Parameter \\"target\\" must be valid."}}',
      ),
    ).toMatch(/отклонил запрос \(HTTP 400\): Parameter/);
    expect(reachError('Globalping ответил 503: bad gateway')).toMatch(/временно недоступен/);
    expect(reachError('сервер не в сети')).toBe('сервер не в сети');
  });
});

describe('общее время графиков и MTProxyL', () => {
  it('проверки агента - в :00 и :30, не раньше чем через минуту', async () => {
    const { nextTick } = await import('../src/lib/ru-reach.js');
    const at = (s: string) => Date.parse(s);
    expect(new Date(nextTick(at('2026-10-12T09:10:00Z'))).toISOString()).toBe(
      '2026-10-12T09:30:00.000Z',
    );
    expect(new Date(nextTick(at('2026-10-12T09:29:30Z'))).toISOString()).toBe(
      '2026-10-12T10:00:00.000Z',
    );
    expect(new Date(nextTick(at('2026-10-12T09:30:00.005Z'))).toISOString()).toBe(
      '2026-10-12T10:00:00.000Z',
    );
  });

  it('3X-UI снят с сервера - цели его inbound-ов убираются, остальные остаются', async () => {
    const { blank, dropXui } = await import('../src/lib/ru-reach.js');
    const entry: ServerReach = {
      checkedAt: null,
      targets: [
        blank('ip', 'Адрес сервера', 'tcp', 22, 'agent'),
        blank('xui:1', '3X-UI VLESS Reality', 'tls', 443, 'agent', 'www.microsoft.com'),
        blank('xui:2', '3X-UI VLESS XHTTP', 'tls', 8443, 'agent'),
      ],
    };
    expect(dropXui(entry)).toBe(true);
    expect(entry.targets.map((t) => t.key)).toEqual(['ip']);
    expect(dropXui(entry)).toBe(false);
  });

  it('каждая новая проверка MTProxyL - точка с зондами; без MTProxyL цели нет', async () => {
    const { mergeMt } = await import('../src/lib/ru-reach.js');
    const entry: ServerReach = { checkedAt: null, targets: [] };
    const details = (checkedAt: string, error?: string) => ({
      ruReach: {
        checkedAt,
        target: '1.2.3.4:8443',
        percent: 95,
        total: 20,
        ok: 19,
        ...(error ? { error } : {}),
        probes: [
          { city: 'Tomsk', asn: 1, network: 'N', ok: true, raw: 'x' },
          { city: 'Kursk', asn: 2, network: 'M', ok: false, error: 'timeout' },
        ],
      },
    });
    const { readProbes } = await import('../src/lib/ru-reach.js');
    expect(
      readProbes([
        { city: 'Moscow', asn: 1, network: 'N', ok: true, rtt: 18.04 },
        { city: 'Kursk', asn: 2, network: 'M', ok: false, error: 'timeout', rtt: 5 },
        { city: 'Omsk', asn: 3, network: 'K', ok: true, rtt: -1 },
      ]),
    ).toEqual([
      { city: 'Moscow', asn: 1, network: 'N', ok: true, rtt: 18 },
      { city: 'Kursk', asn: 2, network: 'M', ok: false, error: 'timeout' },
      { city: 'Omsk', asn: 3, network: 'K', ok: true },
    ]);
    const r = mergeMt(entry, details('2026-10-12T09:03:00Z'), true);
    expect(r.probes?.probes).toEqual([
      { city: 'Tomsk', asn: 1, network: 'N', ok: true },
      { city: 'Kursk', asn: 2, network: 'M', ok: false, error: 'timeout' },
    ]);
    expect(mergeMt(entry, details('2026-10-12T09:03:00Z'), true)).toEqual({});
    mergeMt(entry, details('2026-10-12T09:18:00Z'), true);
    const t = entry.targets[0];
    expect(t?.port).toBe(8443);
    expect(t?.history).toHaveLength(2);
    mergeMt(entry, details('2026-10-12T09:33:00Z', 'quota'), true);
    expect(entry.targets[0]?.error).toMatch(/quota/);
    expect(t?.history).toHaveLength(2);
    mergeMt(entry, undefined, false);
    expect(entry.targets).toHaveLength(0);
  });
});
