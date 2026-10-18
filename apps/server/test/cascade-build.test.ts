import { describe, expect, it } from 'vitest';
import {
  CASCADE_DIRECT,
  buildOutbound,
  buildRules,
  entryInbound,
  mergeTemplate,
  ownParts,
  parseList,
} from '../src/lib/cascade-build.js';

const base = {
  id: 'c1',
  inboundTag: 'in-20443-tcp',
  directList: [],
  exitList: [],
  blockQuic: false,
  geoRu: true,
};
const tags = (rules: Record<string, unknown>[]) => rules.map((r) => r.ruleTag);

describe('правила каскада', () => {
  it('всё через выход - одно правило по inbound-у входа', () => {
    const r = buildRules({ ...base, mode: 'all' });
    expect(r).toEqual([
      {
        type: 'field',
        ruleTag: 'vp-cascade-c1-rest',
        inboundTag: ['in-20443-tcp'],
        outboundTag: 'vp-cascade-c1',
      },
    ]);
  });

  it('российское напрямую: заблокированное через выход выше российского, остальное - выход', () => {
    const r = buildRules({ ...base, mode: 'ru-direct' });
    expect(tags(r)).toEqual([
      'vp-cascade-c1-blocked-domains',
      'vp-cascade-c1-ru-domains',
      'vp-cascade-c1-ru-ips',
      'vp-cascade-c1-rest',
    ]);
    expect(r[1]?.outboundTag).toBe(CASCADE_DIRECT);
    expect(r[1]?.domain).toContain('domain:ru');
    expect(r[2]?.ip).toEqual(['geoip:ru']);
    expect(r[3]?.outboundTag).toBe('vp-cascade-c1');
  });

  it('без geosite_RU: российское напрямую без списков заблокированного, режим blocked - ошибка', () => {
    const r = buildRules({ ...base, mode: 'ru-direct', geoRu: false });
    expect(tags(r)).not.toContain('vp-cascade-c1-blocked-domains');
    expect(JSON.stringify(r)).not.toContain('geosite_RU');
    expect(() => buildRules({ ...base, mode: 'blocked', geoRu: false })).toThrow(/geosite_RU/);
  });

  it('только заблокированное: списки через выход, остальное напрямую', () => {
    const r = buildRules({ ...base, mode: 'blocked' });
    expect(r.at(-1)?.outboundTag).toBe(CASCADE_DIRECT);
    expect(r[0]?.domain).toEqual(['ext:geosite_RU.dat:ru-blocked']);
  });

  it('свои списки и QUIC - выше режима', () => {
    const r = buildRules({
      ...base,
      mode: 'ru-direct',
      blockQuic: true,
      exitList: ['habr.com', '1.2.3.0/24'],
      directList: ['regexp:\\.corp$'],
    });
    expect(tags(r).slice(0, 4)).toEqual([
      'vp-cascade-c1-quic',
      'vp-cascade-c1-exit-domains',
      'vp-cascade-c1-exit-ips',
      'vp-cascade-c1-direct-domains',
    ]);
    expect(r[1]?.domain).toEqual(['domain:habr.com']);
  });

  it('список: домены, префиксы xray, IP и подсети; мусор - в invalid', () => {
    expect(
      parseList([
        'Example.com',
        'full:a.b.ru',
        '10.0.0.0/8',
        '2001:db8::/32',
        'geoip:cn',
        'не домен',
        '# заметка',
        '',
      ]),
    ).toEqual({
      domains: ['domain:example.com', 'full:a.b.ru'],
      ips: ['10.0.0.0/8', '2001:db8::/32', 'geoip:cn'],
      invalid: ['не домен'],
    });
  });
});

describe('шаблон', () => {
  const owner = {
    log: { loglevel: 'warning' },
    outbounds: [
      { tag: 'direct', protocol: 'freedom' },
      { tag: 'warp', protocol: 'wireguard' },
    ],
    routing: {
      domainStrategy: 'AsIs',
      rules: [
        { type: 'field', inboundTag: ['api'], outboundTag: 'api' },
        { type: 'field', domain: ['geosite:openai'], outboundTag: 'warp' },
      ],
    },
  };
  const ob = buildOutbound('c1', {
    address: '203.0.113.20',
    port: 443,
    uuid: 'u',
    publicKey: 'pk',
    shortId: 'ab',
    sni: 'example.com',
    fingerprint: 'firefox',
  });
  const rules = buildRules({ ...base, mode: 'all' });

  it('свои части - после правила api, чужое остаётся как было', () => {
    const t = mergeTemplate(owner, [ob], rules);
    expect(t.routing?.rules?.map((r) => r.ruleTag ?? r.outboundTag)).toEqual([
      'api',
      'vp-cascade-c1-rest',
      'warp',
    ]);
    expect(t.outbounds?.map((o) => o.tag)).toEqual([
      'direct',
      'warp',
      'vp-cascade-direct',
      'vp-cascade-blocked',
      'vp-cascade-c1',
    ]);
    expect(t.log).toEqual(owner.log);
  });

  it('повтор не меняет шаблон; без каскадов своего не остаётся', () => {
    const once = mergeTemplate(owner, [ob], rules);
    const twice = mergeTemplate(once, [ob], rules);
    expect(ownParts(twice)).toBe(ownParts(once));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    const clean = mergeTemplate(once, [], []);
    expect(clean).toEqual(owner);
  });

  it('outbound - VLESS Reality с Vision к выходу', () => {
    expect(ob).toMatchObject({
      protocol: 'vless',
      settings: {
        vnext: [{ address: '203.0.113.20', port: 443, users: [{ flow: 'xtls-rprx-vision' }] }],
      },
      streamSettings: {
        security: 'reality',
        realitySettings: { publicKey: 'pk', serverName: 'example.com' },
      },
    });
  });
});

it('inbound входа - со sniffing routeOnly', () => {
  const i = entryInbound({
    port: 20443,
    remark: '-> NetCore',
    target: 'ya.ru:443',
    serverNames: ['ya.ru'],
    fingerprint: 'firefox',
  });
  expect(JSON.parse(String(i.sniffing))).toEqual({
    enabled: true,
    destOverride: ['http', 'tls', 'quic'],
    routeOnly: true,
  });
  expect(i.port).toBe(20443);
});
