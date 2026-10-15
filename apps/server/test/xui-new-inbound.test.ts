import { createPrivateKey, createPublicKey } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildInbound,
  freeRemark,
  isYoutubeName,
  pickTargets,
  portBusy,
  randomFreePort,
  realityKeys,
  realityNames,
  realityOfInbounds,
  shortIds,
} from '../src/lib/xui-new-inbound.js';

describe('новые inbound-ы VLESS', () => {
  it('ключи Reality: публичный выводится из приватного', () => {
    const k = realityKeys();
    expect(k.privateKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(k.publicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const priv = createPrivateKey({
      key: { kty: 'OKP', crv: 'X25519', d: k.privateKey, x: k.publicKey },
      format: 'jwk',
    });
    expect(createPublicKey(priv).export({ format: 'jwk' }).x).toBe(k.publicKey);
  });

  it('shortIds: 8 hex длиной 2-16', () => {
    const ids = shortIds();
    expect(ids).toHaveLength(8);
    expect(ids.map((x) => x.length).sort((a, b) => a - b)).toEqual([2, 4, 6, 8, 10, 12, 14, 16]);
    for (const x of ids) expect(x).toMatch(/^[0-9a-f]+$/);
  });

  it('имена YouTube и wildcard отбрасываются', () => {
    for (const n of [
      'youtube.com',
      'music.youtube.com',
      'youtu.be',
      'yt.be',
      'youtubekids.com',
      'i.ytimg.com',
      'r1.googlevideo.com',
    ])
      expect(isYoutubeName(n)).toBe(true);
    for (const n of ['google.com', 'goo.gl', 'g.co', 'aws.amazon.com'])
      expect(isYoutubeName(n)).toBe(false);
    expect(
      realityNames(['*.google.com', 'Google.com', 'google.com', 'youtube.com', '1.2.3.4', 'g.co']),
    ).toEqual(['google.com', 'g.co']);
  });

  it('цели из скана: подходящие, по задержке, имя проверки первым', () => {
    const t = pickTargets([
      {
        target: 'www.amazon.com:443',
        host: 'www.amazon.com',
        feasible: true,
        latencyMs: 40,
        serverNames: ['amazon.com', 'www.amazon.com'],
      },
      {
        target: 'dl.google.com:443',
        host: 'dl.google.com',
        feasible: true,
        latencyMs: 12,
        serverNames: ['*.google.com', 'google.com', 'dl.google.com', 'youtube.com'],
      },
      {
        target: 'www.sony.com:443',
        host: 'www.sony.com',
        feasible: false,
        latencyMs: 5,
        serverNames: ['www.sony.com'],
      },
      {
        target: 'yt.example:443',
        host: 'youtube.com',
        feasible: true,
        latencyMs: 1,
        serverNames: ['youtube.com', 'youtu.be'],
      },
    ]);
    expect(t.map((x) => x.target)).toEqual(['dl.google.com:443', 'www.amazon.com:443']);
    expect(t[0]?.serverNames).toEqual(['dl.google.com', 'google.com']);
    expect(t[1]?.serverNames[0]).toBe('www.amazon.com');
  });

  it('порт: занят inbound-ом или любым процессом, в том числе самим xray', () => {
    const inbounds = [{ id: 1, remark: 'VLESS', port: 28512 }];
    const ls = [
      { proto: 'tcp' as const, port: 443, process: 'caddy', open: true },
      { proto: 'tcp' as const, port: 62789, process: 'xray-linux-amd6', open: false },
      { proto: 'udp' as const, port: 8443, process: 'x', open: true },
    ];
    expect(portBusy(28512, inbounds, ls)).toMatch(/VLESS/);
    expect(portBusy(443, inbounds, ls)).toMatch(/caddy/);
    expect(portBusy(62789, inbounds, ls)).toMatch(/xray/);
    expect(portBusy(8443, inbounds, ls)).toBeNull();
    let n = 0;
    const seq = [20000, 20000, 20001];
    expect(
      randomFreePort(
        (p) => p === 20000,
        () => seq[n++] ?? 30000,
      ),
    ).toBe(20001);
  });

  it('подпись без повтора', () => {
    expect(freeRemark('XHTTP', ['VLESS'])).toBe('XHTTP');
    expect(freeRemark('XHTTP', ['xhttp', 'XHTTP 2'])).toBe('XHTTP 3');
  });

  it('тело inbounds/add: RAW с Vision, XHTTP как у рабочих', () => {
    const keys = { privateKey: 'p'.repeat(43), publicKey: 'q'.repeat(43) };
    const base = {
      port: 23456,
      remark: 'VLESS',
      target: 'dl.google.com:443',
      serverNames: ['google.com'],
      fingerprint: 'firefox' as const,
    };
    const raw = buildInbound({ ...base, kind: 'raw' }, keys, ['ab']);
    expect(raw).toMatchObject({ protocol: 'vless', port: 23456, enable: true, listen: '' });
    const rs = JSON.parse(raw.streamSettings as string);
    expect(rs.network).toBe('tcp');
    expect(rs.realitySettings).toMatchObject({
      target: 'dl.google.com:443',
      serverNames: ['google.com'],
      privateKey: keys.privateKey,
      shortIds: ['ab'],
      settings: { publicKey: keys.publicKey, fingerprint: 'firefox' },
    });
    expect(JSON.parse(raw.settings as string)).toMatchObject({ clients: [], decryption: 'none' });
    expect(JSON.parse(raw.sniffing as string)).toEqual({ enabled: false });
    const x = buildInbound({ ...base, kind: 'xhttp', port: 8443, remark: 'XHTTP' }, keys, ['ab']);
    const xs = JSON.parse(x.streamSettings as string);
    expect(xs.network).toBe('xhttp');
    expect(xs.xhttpSettings).toMatchObject({ path: '/', mode: 'auto', xPaddingBytes: '100-1000' });
    expect(xs.sockopt).toEqual({ tcpFastOpen: true, tcpcongestion: 'bbr' });
    expect(JSON.parse(x.sniffing as string).enabled).toBe(true);
  });

  it('цели нынешних inbound-ов (для "Как у inbound")', () => {
    const list = [
      {
        id: 2,
        remark: 'XHTTP',
        streamSettings: JSON.stringify({
          security: 'reality',
          realitySettings: {
            target: 'dl.google.com:443',
            serverNames: ['google.com', 'youtube.com'],
            settings: { fingerprint: 'chrome' },
          },
        }),
      },
      { id: 3, remark: 'узел', nodeId: 5, streamSettings: '{"security":"reality"}' },
      { id: 4, remark: 'TLS', streamSettings: '{"security":"tls"}' },
    ];
    expect(realityOfInbounds(list)).toEqual([
      {
        id: 2,
        remark: 'XHTTP',
        target: 'dl.google.com:443',
        serverNames: ['google.com'],
        fingerprint: 'chrome',
      },
    ]);
  });
});
