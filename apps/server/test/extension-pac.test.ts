import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Правила расширения Chrome (apps/extension/rules.js): свои адреса
 * "напрямую" и PAC. Файл - обычный скрипт расширения, грузится в vm.
 */
type Rules = {
  parseDirect: (t: string) => { rules: Record<string, unknown[]>; errors: string[]; count: number };
  buildPac: (st: Record<string, unknown>, servers: unknown[], priming?: boolean) => string;
};
const ctx = createContext({ URL, module: { exports: {} } });
runInContext(readFileSync(join(__dirname, '../../extension/rules.js'), 'utf8'), ctx);
const { parseDirect, buildPac } = (ctx.module as { exports: Rules }).exports;

/** Помощники PAC, как в Chrome: isPlainHostName, shExpMatch, isInNetEx (v6). */
function v6(a: string): bigint {
  const [l, r = ''] = a.split('::');
  const L = l ? l.split(':') : [];
  const R = r ? r.split(':') : [];
  const parts = a.includes('::') ? [...L, ...Array(8 - L.length - R.length).fill('0'), ...R] : L;
  return parts.reduce((n, p) => (n << 16n) + BigInt(Number.parseInt(p || '0', 16)), 0n);
}
const helpers = {
  isPlainHostName: (h: string) => !h.includes('.') && !h.includes(':'),
  shExpMatch: (s: string, p: string) =>
    new RegExp(
      `^${p
        .replace(/[.+^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.')}$`,
    ).test(s),
  isInNetEx: (ip: string, prefix: string) => {
    const [net, bits] = prefix.split('/');
    if (!ip.includes(':') || !net) return false;
    const b = BigInt(128 - Number(bits));
    return v6(ip) >> b === v6(net) >> b;
  },
};

const servers = [
  {
    id: 's1',
    title: 'SE :: Hoster',
    host: 'hoster.example.com',
    ports: [443, 8444],
    user: 'u',
    pass: 'p',
    probe: 'aa.test',
  },
];
const CHAIN = 'HTTPS hoster.example.com:443; HTTPS hoster.example.com:8444';

function pac(directText: string, ruDirect = false) {
  const code = buildPac(
    { server: 'auto', ruDirect, subUrl: 'https://sub.example.com/sub/x/browser', directText },
    servers,
  );
  const c = createContext({ ...helpers });
  runInContext(code, c);
  return (url: string) => {
    const host = new URL(url).hostname;
    return (c.FindProxyForURL as (u: string, h: string) => string)(url, host);
  };
}

describe('свои адреса напрямую: разбор', () => {
  it('все форматы, комментарии, кириллица в punycode', () => {
    const r = parseDirect(
      [
        'example.com',
        '*.corp.example',
        '.intra.example',
        'cdn*.example.net  # маска',
        '1.2.3.4',
        '10.20.0.0/16',
        '2001:db8::/32',
        '[2001:db8::1]',
        'https://site.example/page?x=1',
        'site2.example/path',
        'сайт.рф',
        '',
        '# только комментарий',
      ].join('\n'),
    );
    expect(r.errors).toEqual([]);
    expect(r.count).toBe(11);
    expect(r.rules.hosts).toEqual(['example.com', '1.2.3.4', '2001:db8::1', 'xn--80aswg.xn--p1ai']);
    expect(r.rules.suffixes).toEqual(['corp.example', 'intra.example']);
    expect(r.rules.patterns).toEqual(['cdn*.example.net']);
    expect(r.rules.cidr4).toEqual([[(10 << 24) + (20 << 16), 16]]);
    expect(r.rules.cidr6).toEqual(['2001:db8::/32']);
    expect(r.rules.urls).toEqual([
      { h: 'site.example', p: '/page?x=1' },
      { h: 'site2.example', p: '/path' },
    ]);
  });

  it('ошибки - с номером строки', () => {
    const r = parseDirect('ok.example\n1.2.3.300\n10.0.0.0/40\nftp://x.example/a\nfoo bar\n*.\n');
    expect(r.errors).toHaveLength(5);
    expect(r.errors[0]).toMatch(/^строка 2 \(1\.2\.3\.300\): неверный IPv4-адрес/);
    expect(r.errors[1]).toContain('подсеть');
    expect(r.errors[2]).toContain('http');
  });
});

describe('PAC', () => {
  it('без своих адресов: всё через прокси, кроме служебного', () => {
    const f = pac('');
    expect(f('https://example.com/')).toBe(CHAIN);
    expect(f('https://ya.ru/')).toBe(CHAIN);
    expect(f('https://sub.example.com/c/x')).toBe('DIRECT');
    expect(f('https://hoster.example.com:8444/')).toBe('DIRECT');
    expect(f('http://192.168.1.1/')).toBe('DIRECT');
    expect(f('http://aa.test/p8444')).toBe('HTTPS hoster.example.com:8444');
  });

  it('российские зоны - по галочке', () => {
    const f = pac('', true);
    expect(f('https://ya.ru/')).toBe('DIRECT');
    expect(f('https://mail.yandex.ru/')).toBe('DIRECT');
    expect(f('https://xn--80aswg.xn--p1ai/')).toBe('DIRECT');
    expect(f('https://forum.su/')).toBe('DIRECT');
    expect(f('https://ru.wikipedia.org/')).toBe(CHAIN);
  });

  it('свои адреса: домен, поддомены, маска, IP, подсети, страницы', () => {
    const f = pac(
      'example.com\n*.corp.example\ncdn*.example.net\n1.2.3.4\n10.20.0.0/16\n203.0.113.0/24\n2001:db8::/32\nhttps://site.example/page\nhttp://plain.example/docs/',
    );
    expect(f('https://example.com/a')).toBe('DIRECT');
    expect(f('https://www.example.com/')).toBe(CHAIN); // только сам домен
    expect(f('https://corp.example/')).toBe('DIRECT');
    expect(f('https://a.b.corp.example/')).toBe('DIRECT');
    expect(f('https://notcorp.example/')).toBe(CHAIN);
    expect(f('https://cdn7.example.net/')).toBe('DIRECT');
    expect(f('https://img.example.net/')).toBe(CHAIN);
    expect(f('http://1.2.3.4/')).toBe('DIRECT');
    expect(f('http://1.2.3.5/')).toBe(CHAIN);
    expect(f('http://203.0.113.77:8080/')).toBe('DIRECT');
    expect(f('http://203.0.114.1/')).toBe(CHAIN);
    expect(f('http://[2001:db8::5]/')).toBe('DIRECT');
    expect(f('http://[2001:db9::5]/')).toBe(CHAIN);
    // https - весь сайт (Chrome не отдаёт путь), http - по началу пути
    expect(f('https://site.example/')).toBe('DIRECT');
    expect(f('http://plain.example/docs/x')).toBe('DIRECT');
    expect(f('http://plain.example/other')).toBe(CHAIN);
  });

  it('текст PAC - только ASCII (иначе Chrome его не примет)', () => {
    const code = buildPac(
      {
        server: 'auto',
        ruDirect: true,
        subUrl: 'https://sub.example.com/x',
        directText: '# мои\nсайт.рф\nhttp://пример.рф/путь',
      },
      [{ ...servers[0], title: 'Швеция :: Hoster' }],
    );
    expect([...code].every((ch) => ch.charCodeAt(0) < 128)).toBe(true);
  });

  it('прогрев: всё, кроме секретных имён, - на мёртвый прокси', () => {
    const code = buildPac(
      { server: 'auto', ruDirect: false, subUrl: '', directText: 'example.com' },
      servers,
      true,
    );
    const c = createContext({ ...helpers });
    runInContext(code, c);
    const f = c.FindProxyForURL as (u: string, h: string) => string;
    expect(f('https://other.example/', 'other.example')).toBe('PROXY 127.0.0.1:9');
    expect(f('http://aa.test/p443', 'aa.test')).toBe('HTTPS hoster.example.com:443');
  });
});
