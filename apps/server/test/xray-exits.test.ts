import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { XrayManager, type XrayOutbound } from '../src/lib/xray.js';

const ob = (serverId: string, port = 443): XrayOutbound => ({
  serverId,
  serverName: serverId,
  inboundId: 1,
  inboundRemark: 'VLESS',
  address: `${serverId}.example.com`,
  port,
  uuid: '00000000-0000-0000-0000-000000000000',
  publicKey: 'pk',
  shortId: 'ab',
  sni: 'example.com',
  fingerprint: 'chrome',
  flow: '',
  updatedAt: new Date().toISOString(),
});

describe('XrayManager: основной и запасные выходы', () => {
  it('основной первым, его сервер среди запасных не повторяется; у каждого свой вход', async () => {
    const x = new XrayManager(createDb(':memory:'), '/tmp/xray-test', {
      info: () => undefined,
      warn: () => undefined,
    });
    await x.save(ob('a'));
    expect(await x.setSpares([ob('a'), ob('b'), ob('c')], [])).toBe(true);
    expect(x.exits().map((e) => e.serverId)).toEqual(['a', 'b', 'c']);
    // тот же набор (другое время подготовки) - перезапуск не нужен
    expect(await x.setSpares([ob('a'), ob('b'), ob('c')], [])).toBe(false);
    expect(await x.setSpares([ob('b', 8443)], [])).toBe(true);

    const cfg = (x as unknown as { config: (l: XrayOutbound[]) => Record<string, unknown> }).config(
      x.exits(),
    ) as {
      inbounds: { port: number; tag: string }[];
      routing: { rules: { inboundTag: string[]; outboundTag: string }[] };
    };
    expect(cfg.inbounds.map((i) => i.port)).toEqual([3128, 3129]);
    expect(cfg.routing.rules.map((r) => `${r.inboundTag[0]}>${r.outboundTag}`)).toEqual([
      'in-0>out-0',
      'in-1>out-1',
    ]);
    const st = x.status();
    expect(st.exits.map((e) => [e.serverId, e.primary])).toEqual([
      ['a', true],
      ['b', false],
    ]);
    expect(JSON.stringify(st)).not.toContain('00000000-0000-0000-0000-000000000000');

    // сервер сменил IP: его выход - на новый адрес
    await (x as unknown as { retarget: (id: string, a: string) => Promise<boolean> }).retarget(
      'b',
      '198.51.100.7',
    );
    expect(x.exits().find((e) => e.serverId === 'b')?.address).toBe('198.51.100.7');

    // выход выключен - запасных тоже нет
    await x.save(null);
    expect(x.exits()).toEqual([]);
  });
});
