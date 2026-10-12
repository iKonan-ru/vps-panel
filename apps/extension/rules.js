// Правила маршрутизации: разбор своих адресов "напрямую", PAC для Chrome и решение по адресу
// для Firefox (proxy.onRequest). Без API браузера - тот же файл подключают фон, окно и тесты
// панели (apps/server/test/extension-pac.test.ts).

/** Домен в punycode (сайт.рф -> xn--80aswg.xn--p1ai); null - не домен. */
function asciiHost(s) {
  try {
    const h = new URL(`http://${s}/`).hostname;
    return /^[a-z0-9.-]+$/.test(h) && !h.startsWith('.') && !h.endsWith('.') && !h.includes('..') ? h : null;
  } catch {
    return null;
  }
}

function ip4num(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return -1;
  const o = m.slice(1).map(Number);
  if (o.some((x) => x > 255)) return -1;
  return ((o[0] << 24) >>> 0) + (o[1] << 16) + (o[2] << 8) + o[3];
}

/** IPv6 в краткой записи (как её даёт Chrome); null - не IPv6. */
function ip6(s) {
  const a = s.replace(/^\[|\]$/g, '');
  if (!a.includes(':') || !/^[0-9a-f:.]+$/i.test(a)) return null;
  try {
    return new URL(`http://[${a}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

/**
 * Одна строка: домен (только он), *.домен или .домен (он и поддомены), маска со звёздочками,
 * IPv4, IPv6, подсеть CIDR (v4 и v6), страница (адрес с путём). Итог - { kind, value } или
 * { error }.
 */
function parseRule(line) {
  let m = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(line);
  if (m) {
    const n = ip4num(m[1]);
    const bits = Number(m[2]);
    if (n < 0 || bits > 32) return { error: 'неверная подсеть IPv4' };
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    return { kind: 'cidr4', value: [(n & mask) >>> 0, bits] };
  }
  if (ip4num(line) >= 0) return { kind: 'hosts', value: line };
  if (/^\d+(\.\d+){3}$/.test(line)) return { error: 'неверный IPv4-адрес' };
  m = /^\[?([0-9a-f:.]+)\]?\/(\d{1,3})$/i.exec(line);
  if (m && m[1].includes(':')) {
    const a = ip6(m[1]);
    if (!a || Number(m[2]) > 128) return { error: 'неверная подсеть IPv6' };
    return { kind: 'cidr6', value: `${a}/${Number(m[2])}` };
  }
  if (line.includes(':') && /^\[?[0-9a-f:.]+\]?$/i.test(line)) {
    const a = ip6(line);
    return a ? { kind: 'hosts', value: a } : { error: 'неверный адрес IPv6' };
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(line) || line.includes('/')) {
    let u;
    try {
      u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(line) ? line : `http://${line}`);
    } catch {
      return { error: 'неверный адрес страницы' };
    }
    if (!/^https?:$/.test(u.protocol) || !u.hostname) return { error: 'страница: только http или https' };
    const path = u.pathname + u.search;
    // адрес без пути - это просто сайт
    if (path === '/' || path === '') return { kind: 'hosts', value: u.hostname.replace(/^\[|\]$/g, '') };
    return { kind: 'urls', value: { h: u.hostname.replace(/^\[|\]$/g, ''), p: path } };
  }
  if (line.startsWith('*.') || (line.startsWith('.') && !line.startsWith('..'))) {
    const d = asciiHost(line.replace(/^\*?\./, ''));
    if (!d || d.includes('*')) return { error: 'неверный домен' };
    return { kind: 'suffixes', value: d };
  }
  if (line.includes('*')) {
    const labels = line.toLowerCase().split('.');
    const out = [];
    for (const l of labels) {
      if (!l) return { error: 'неверная маска' };
      if (l.includes('*')) {
        if (!/^[a-z0-9*-]+$/.test(l)) return { error: 'маска: латиница, цифры, дефис и *' };
        out.push(l);
      } else {
        const a = asciiHost(l);
        if (!a) return { error: 'неверная маска' };
        out.push(a);
      }
    }
    return { kind: 'patterns', value: out.join('.') };
  }
  const h = asciiHost(line);
  return h ? { kind: 'hosts', value: h } : { error: 'не распознано' };
}

/** Текст (по правилу в строке, # - комментарий) -> правила и ошибки по строкам. */
function parseDirect(text) {
  const rules = { hosts: [], suffixes: [], patterns: [], cidr4: [], cidr6: [], urls: [] };
  const errors = [];
  String(text || '')
    .split('\n')
    .forEach((raw, i) => {
      const line = raw.replace(/#.*/, '').trim();
      if (!line) return;
      const r = parseRule(line);
      if (r.error) errors.push(`строка ${i + 1} (${line}): ${r.error}`);
      else rules[r.kind].push(r.value);
    });
  const count = Object.values(rules).reduce((n, l) => n + l.length, 0);
  return { rules, errors, count };
}

/**
 * Данные маршрутизации: всё - на прокси (цепочкой: выбранный сервер, остальные - запасные),
 * кроме своих адресов, российских зон (по галочке) и списка "напрямую". priming - на время
 * прогрева пароля в Chrome: всё, кроме секретных имён, - на заведомо мёртвый прокси (страница в
 * эту секунду не откроется, но и мимо прокси не уйдёт). Подсети сравниваются только с адресами,
 * набранными цифрами: имя сайта не резолвится (лишний запрос DNS мимо прокси и задержка).
 */
function routeContext(st, servers, priming) {
  const chosen = st.server === 'auto' ? servers : servers.filter((s) => s.id === st.server);
  const list = chosen.length ? chosen : servers;
  const chain = priming
    ? 'PROXY 127.0.0.1:9'
    : list.flatMap((s) => s.ports.map((p) => `HTTPS ${s.host}:${p}`)).join('; ');
  // секретное имя сервера - только на его же прокси, порт - из пути (/p443, /p8444)
  const probes = {};
  for (const s of servers) {
    probes[s.probe] = {};
    for (const p of s.ports) probes[s.probe][String(p)] = `HTTPS ${s.host}:${p}`;
  }
  let subHost = '';
  try {
    subHost = new URL(st.subUrl).hostname;
  } catch {}
  // сами серверы - напрямую: замер пинга (страница-заглушка сервера); через прокси запрос к
  // собственному адресу сервера отбил бы его acl
  const hosts = {};
  for (const s of servers) hosts[s.host] = 1;
  const r = parseDirect(st.directText).rules;
  const own = {};
  for (const h of r.hosts) own[h] = 1;
  return {
    CHAIN: chain,
    PROBES: probes,
    HOSTS: hosts,
    SUBHOST: subHost,
    RU: Boolean(st.ruDirect),
    D: { hosts: own, suffixes: r.suffixes, patterns: r.patterns, cidr4: r.cidr4, cidr6: r.cidr6, urls: r.urls },
  };
}

// Решение по адресу - одни и те же функции для PAC Chrome (их текст вставляется в PAC) и для
// proxy.onRequest Firefox (вызываются здесь же). Поэтому внутри них только ASCII (Chrome не
// принимает PAC с другими символами), стиль ES5 и помощники PAC: isPlainHostName, shExpMatch,
// isInNetEx (в Firefox - свои реализации ниже). Ответ - строка PAC: "DIRECT" или цепочка.
// Страница https идёт напрямую целиком: Chrome не отдаёт в PAC путь https-адреса, http
// сравнивается по началу пути.
function pacIp4(h) {
  var m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  return m ? ((+m[1] << 24) >>> 0) + (+m[2] << 16) + (+m[3] << 8) + (+m[4]) : -1;
}
function pacOwn(url, host, D) {
  var i;
  if (D.hosts[host]) return true;
  for (i = 0; i < D.suffixes.length; i++) {
    var s = D.suffixes[i];
    if (host === s || host.slice(-s.length - 1) === '.' + s) return true;
  }
  for (i = 0; i < D.patterns.length; i++) if (shExpMatch(host, D.patterns[i])) return true;
  var n = pacIp4(host);
  if (n >= 0)
    for (i = 0; i < D.cidr4.length; i++) {
      var b = D.cidr4[i][1], mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
      if (((n & mask) >>> 0) === D.cidr4[i][0]) return true;
    }
  if (host.indexOf(':') >= 0 && typeof isInNetEx === 'function')
    for (i = 0; i < D.cidr6.length; i++) if (isInNetEx(host, D.cidr6[i])) return true;
  var path = url.replace(/^[a-z]+:\/\/[^\/]*/i, '') || '/';
  for (i = 0; i < D.urls.length; i++)
    if (host === D.urls[i].h && (url.slice(0, 6) === 'https:' || path.indexOf(D.urls[i].p) === 0)) return true;
  return false;
}
function pacRoute(url, host, C) {
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  var pr = C.PROBES[host];
  if (pr) {
    var m = /^http:\/\/[^\/]+\/p(\d+)/.exec(url);
    return m && pr[m[1]] ? pr[m[1]] : C.CHAIN;
  }
  if (host === C.SUBHOST || C.HOSTS[host]) return 'DIRECT';
  if (isPlainHostName(host) || host === 'localhost' || /\.(localhost|local|lan|internal)$/.test(host)) return 'DIRECT';
  if (/^(10|127)\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(host) || /^169\.254\./.test(host) || host === '::1') return 'DIRECT';
  if (C.RU && /(^|\.)(ru|su|xn--p1ai)$/.test(host)) return 'DIRECT';
  if (pacOwn(url, host, C.D)) return 'DIRECT';
  return C.CHAIN;
}

/** PAC для Chrome: данные и функции решения выше; данные - JSON с \uXXXX вместо не-ASCII. */
function buildPac(st, servers, priming) {
  const json = (v) =>
    JSON.stringify(v).replace(/[\u0080-\uffff]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `var C=${json(routeContext(st, servers, priming))};
${pacIp4}
${pacOwn}
${pacRoute}
function FindProxyForURL(url, host) {
  return pacRoute(url, host, C);
}`;
}

// Помощники PAC для Firefox (там решение идёт не в PAC, а в proxy.onRequest). Имена - как в PAC:
// их зовут функции решения выше. В Chrome эти определения в PAC не попадают.
function isPlainHostName(h) {
  return h.indexOf('.') < 0 && h.indexOf(':') < 0;
}
function shExpMatch(s, p) {
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(s);
}
function ip6big(a) {
  const [l, r = ''] = a.split('::');
  const L = l ? l.split(':') : [];
  const R = r ? r.split(':') : [];
  const parts = a.includes('::') ? [...L, ...Array(8 - L.length - R.length).fill('0'), ...R] : L;
  return parts.reduce((n, p) => (n << 16n) + BigInt(Number.parseInt(p || '0', 16)), 0n);
}
function isInNetEx(ip, prefix) {
  const [net, bits] = prefix.split('/');
  if (!ip.includes(':') || !net || ip.includes('.')) return false;
  const b = BigInt(128 - Number(bits));
  try {
    return ip6big(ip) >> b === ip6big(net) >> b;
  } catch {
    return false;
  }
}

if (typeof module !== 'undefined')
  module.exports = { parseDirect, parseRule, buildPac, routeContext, pacRoute };
