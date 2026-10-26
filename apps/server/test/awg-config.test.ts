import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import {
  type AwgConfigInput,
  type AwgVersion,
  amneziaJson,
  amneziaKey,
  awgClientConf,
  awgTunnelNames,
  clientParams,
  countryFlag,
  wgClientConf,
  wgCompatible,
} from '../src/lib/awg-config.js';

const p = (kv: Record<string, string>) =>
  Object.entries(kv).map(([key, value]) => ({ key, value }));
const PARAMS31 = p({
  Address: '10.8.1.0/24',
  ListenPort: '41721',
  Jc: '5',
  Jmin: '10',
  Jmax: '50',
  S1: '12',
  S2: '12',
  S3: '12',
  S4: '12',
  H1: '1',
  H2: '2',
  H3: '3',
  H4: '4',
  HeaderProtectionKey: 'HPK=',
  RekeyAfterTime: '100-120',
  RandomTrailers: 'on',
  DisableCookies: 'on',
  I1: '<r 2><b 0x8580>',
  J1: '<b 0x01>',
  Itime: '10',
});

const input = (version: AwgVersion, params = PARAMS31): AwgConfigInput => ({
  version,
  params,
  serverPublicKey: 'SERVERPUB=',
  psk: 'PSK=',
  clientPrivateKey: 'CLIENTPRIV=',
  clientPublicKey: 'CLIENTPUB=',
  clientIps: '10.8.1.2/32',
  host: '203.0.113.10',
  port: 41721,
  mtu: 1280,
  dns: ['1.1.1.1', '1.0.0.1'],
  description: 'Hoster: ivan',
  legacy: false,
  address: '10.8.1.0/24',
});

const keysOf = (conf: string) =>
  conf
    .split('\n')
    .filter((l) => l.includes(' = '))
    .map((l) => l.split(' = ')[0]);

describe('clientParams по версиям', () => {
  it('1.0 - только Jc..S2 и H', () => {
    expect(clientParams(input('1.0')).map(([k]) => k)).toEqual([
      'Jc',
      'Jmin',
      'Jmax',
      'S1',
      'S2',
      'H1',
      'H2',
      'H3',
      'H4',
    ]);
  });
  it('2.0 - плюс S3, S4 и I1, без ключей 3.x', () => {
    const k = clientParams(input('2.0')).map(([k]) => k);
    expect(k).toContain('S3');
    expect(k).toContain('I1');
    expect(k).not.toContain('HeaderProtectionKey');
    expect(k).not.toContain('RandomTrailers');
  });
  it('3.1 - всё, что есть на сервере; J1-J3 и Itime никогда', () => {
    const k = clientParams(input('3.1')).map(([k]) => k);
    expect(k).toContain('HeaderProtectionKey');
    expect(k).toContain('DisableCookies');
    expect(k).not.toContain('J1');
    expect(k).not.toContain('Itime');
    expect(k).not.toContain('Address');
    expect(k).not.toContain('ListenPort');
  });
});

describe('awgClientConf', () => {
  it('3.1: интерфейс, пир, keepalive диапазоном', () => {
    const conf = awgClientConf(input('3.1'));
    expect(conf).toContain('Address = 10.8.1.2/32\n');
    expect(conf).toContain('PrivateKey = CLIENTPRIV=\n');
    expect(conf).toContain('MTU = 1280\n');
    expect(conf).toContain('Endpoint = 203.0.113.10:41721\n');
    expect(conf).toContain('PresharedKey = PSK=\n');
    expect(conf).toContain('PersistentKeepalive = 25-35\n');
    expect(keysOf(conf)).not.toContain('J1');
  });
  it('1.0: без ключей новых версий, keepalive числом', () => {
    const conf = awgClientConf(input('1.0'));
    for (const k of ['S3', 'S4', 'I1', 'HeaderProtectionKey', 'RandomTrailers'])
      expect(keysOf(conf)).not.toContain(k);
    expect(conf).toContain('PersistentKeepalive = 25\n');
  });
  it('без PSK строки PresharedKey нет', () => {
    expect(awgClientConf({ ...input('3.1'), psk: '' })).not.toContain('PresharedKey');
  });
});

describe('WireGuard', () => {
  it('3.1 с S=12 - не совместим', () => {
    expect(wgCompatible(input('3.1'))).toBe(false);
  });
  it('сервер без обфускации (S=0, H=1..4) - совместим, в конфиге нет ключей AWG', () => {
    const plain = input(
      '1.0',
      p({ Jc: '4', S1: '0', S2: '0', H1: '1', H2: '2', H3: '3', H4: '4' }),
    );
    expect(wgCompatible(plain)).toBe(true);
    const conf = wgClientConf(plain);
    expect(keysOf(conf)).not.toContain('Jc');
    expect(keysOf(conf)).not.toContain('H1');
  });
});

describe('Amnezia VPN', () => {
  const decode = (key: string) => {
    const raw = Buffer.from(key.replace('vpn://', ''), 'base64url');
    const len = raw.readUInt32BE(0);
    const json = inflateSync(raw.subarray(4));
    expect(json.length).toBe(len);
    return JSON.parse(json.toString());
  };

  it('vpn:// раскодируется обратно в JSON приложения', () => {
    const { key } = amneziaKey(input('3.1'));
    expect(key.startsWith('vpn://')).toBe(true);
    expect(key).not.toContain('=');
    const j = decode(key);
    expect(j.defaultContainer).toBe('amnezia-awg2');
    const awg = j.containers[0].awg;
    expect(awg.port).toBe('41721');
    expect(awg.protocol_version).toBe('3.1');
    expect(awg.HeaderProtectionKey).toBe('HPK=');
    const last = JSON.parse(awg.last_config);
    expect(last.port).toBe(41721);
    expect(last.mtu).toBe('1280');
    expect(last.client_ip).toBe('10.8.1.2');
    expect(last.config).toBe(awgClientConf(input('3.1')));
    expect(typeof last.Jc).toBe('string');
  });

  it('легаси-контейнер - amnezia-awg, у 1.0 нет protocol_version', () => {
    const j = amneziaJson({ ...input('1.0'), legacy: true });
    expect(j.defaultContainer).toBe('amnezia-awg');
    const c = (j.containers as { awg: Record<string, unknown> }[])[0];
    expect(c?.awg.protocol_version).toBeUndefined();
  });

  it('кадры QR собираются обратно в тот же payload', () => {
    const { key, frames } = amneziaKey(input('3.1'));
    const payload = Buffer.from(key.replace('vpn://', ''), 'base64url');
    const parts: Buffer[] = [];
    frames.forEach((f, n) => {
      const b = Buffer.from(f, 'base64url');
      expect(b.readInt16BE(0)).toBe(1984);
      expect(b.readUInt8(2)).toBe(frames.length);
      expect(b.readUInt8(3)).toBe(n);
      const len = b.readUInt32BE(4);
      expect(len).toBeLessThanOrEqual(400);
      parts.push(b.subarray(8, 8 + len));
    });
    expect(Buffer.concat(parts).equals(payload)).toBe(true);
  });
});

describe('awgTunnelNames', () => {
  const fi = countryFlag('FI');
  it('"(флаг) Страна :: Сервер", имя файла для AmneziaWG', () => {
    expect(awgTunnelNames({ provider: 'Hoster', country: 'FI', serverName: 'Hoster One' })).toEqual(
      {
        title: `${fi} Финляндия :: Hoster One`,
        file: 'FI-HosterOne',
      },
    );
    // два сервера одного хостинга в одной стране - разные имена
    expect(
      awgTunnelNames({ provider: 'Hoster', country: 'FI', serverName: 'Hoster Two' }).title,
    ).toBe(`${fi} Финляндия :: Hoster Two`);
  });
  it('дополнительный экземпляр - с версией', () => {
    expect(
      awgTunnelNames({ provider: 'Hoster', country: 'FI', serverName: 'Hoster', version: '2.0' }),
    ).toEqual({ title: `${fi} Финляндия :: Hoster :: AWG 2.0`, file: 'FI-Hoster-2.0' });
  });
  it('недопустимые символы выбрасываются, длина до 15', () => {
    const n = awgTunnelNames({
      provider: 'x',
      country: 'NL',
      serverName: 'my*hosting',
      version: '3.1',
    });
    expect(n.title).toBe(`${countryFlag('NL')} Нидерланды :: my*hosting :: AWG 3.1`);
    expect(n.file).toBe('NL-myhostin-3.1');
    const long = awgTunnelNames({
      provider: 'x',
      country: 'DE',
      serverName: 'VeryLongServerName',
    });
    expect(long.file).toBe('DE-VeryLongServ');
    expect(long.file).toMatch(/^[A-Za-z0-9_=+.-]{1,15}$/);
  });
  it('без имени сервера - хостинг; имя без латиницы - файл по хостингу', () => {
    expect(awgTunnelNames({ provider: 'Web.io', country: 'Москва', serverName: '' })).toEqual({
      title: 'Москва :: Web.io',
      file: 'Web.io',
    });
    expect(awgTunnelNames({ provider: 'Kappa', country: 'SE', serverName: 'Сервер' })).toEqual({
      title: `${countryFlag('SE')} Швеция :: Сервер`,
      file: 'SE-Kappa',
    });
    expect(awgTunnelNames({ provider: '', country: '', serverName: 'Сервер' }).file).toBe('awg');
  });
});
