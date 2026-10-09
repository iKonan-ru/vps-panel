// Фон расширения. Подписка /sub/<токен>/browser даёт серверы: имя, порты, логин, пароль,
// секретное имя.
// Chrome: по ним - PAC (B.proxy), пароль к прокси (onAuthRequired) и прогрев пароля: прокси
// с probe_resistance без пароля прикидывается сайтом и пароль не спрашивает, поэтому расширение
// само идёт на секретное имя - там прокси отвечает 407, Chrome запоминает пароль и дальше шлёт
// его сам в каждом запросе.
// Firefox: решение по каждому запросу (proxy.onRequest) теми же функциями из rules.js, пароль -
// заголовком Proxy-Authorization сразу в CONNECT, прогрев не нужен.

// Chrome - service worker и chrome.*; Firefox - фоновая страница (rules.js подключает манифест)
// и browser.*. У обоих API с промисами.
const B = globalThis.browser || globalThis.chrome;
const FIREFOX = Boolean(globalThis.browser && browser.proxy && browser.proxy.onRequest);
const ACTION = B.action || B.browserAction;
if (typeof importScripts === 'function') importScripts('rules.js'); // parseDirect, buildPac, pacRoute

const DEF = {
  subUrl: '',
  sub: null,
  enabled: false,
  server: 'auto',
  ruDirect: true,
  directText: '',
  error: '',
  fetchedAt: '',
  check: null,
  install: '',
};

async function getState() {
  return { ...DEF, ...(await B.storage.local.get(Object.keys(DEF))) };
}
const setState = (patch) => B.storage.local.set(patch);

/** Ссылка личной страницы или подписки -> адрес подписки расширения; null - не наша ссылка. */
function subscriptionUrl(input) {
  let u;
  try {
    u = new URL(String(input || '').trim());
  } catch {
    return null;
  }
  const local = /^(localhost|127\.0\.0\.1)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(local && u.protocol === 'http:')) return null;
  const m = u.pathname.match(/^\/(?:c|sub)\/([0-9a-f]{32})(?:\/.*)?$/);
  return m ? `${u.origin}/sub/${m[1]}/browser` : null;
}

const activeServers = (st) => (st.sub && !st.sub.suspended ? st.sub.servers || [] : []);

// пароли к прокси: "имя:порт" -> сервер (после перезапуска фона - заново из хранилища)
let creds = null;
function indexCreds(servers) {
  creds = new Map();
  for (const s of servers) for (const p of s.ports) creds.set(`${s.host}:${p}`, s);
}

/** Версия a новее b ("1.2.0" > "1.1.9"). */
function newer(a, b) {
  const x = String(a).split('.').map(Number);
  const y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/**
 * Обновление расширения: панель сообщает в подписке свою версию и
 * архив клиента; у нас старее - значок NEW и плашка в окне. Само себя распакованное расширение
 * не обновит: архив распаковывают поверх папки, затем "Перезапустить" (runtime.reload).
 */
function updateOf(st) {
  // Firefox обновляет подписанное расширение сам (update_url в манифесте)
  if (FIREFOX) return null;
  const e = st.sub && st.sub.extension;
  return e && e.version && newer(e.version, B.runtime.getManifest().version) ? e : null;
}

async function badge(text, color) {
  await ACTION.setBadgeText({ text });
  if (color) await ACTION.setBadgeBackgroundColor({ color });
}

async function webrtc(on) {
  // WebRTC мимо прокси показал бы настоящий адрес
  try {
    if (on)
      await B.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    else await B.privacy.network.webRTCIPHandlingPolicy.clear({});
  } catch {}
}

/** Прогрев пароля на каждом прокси (каждый сервер и порт - отдельный запрос). */
let primedAt = 0;
async function prime(servers, force) {
  if (!force && Date.now() - primedAt < 10_000) return;
  primedAt = Date.now();
  await Promise.all(
    servers.flatMap((s) =>
      s.ports.map((p) => {
        // недоступный сервер не должен держать прогрев: соединение с мёртвым прокси Chrome
        // ждёт десятки секунд
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 8000);
        return fetch(`http://${s.probe}/p${p}?t=${Date.now()}`, {
          cache: 'no-store',
          credentials: 'omit',
          signal: ctl.signal,
        })
          .then((r) => r.status)
          .catch(() => 0)
          .finally(() => clearTimeout(timer));
      }),
    ),
  );
}

// идущее применение настроек: перезагрузка вкладки после ошибки ждёт его конца
let applying = Promise.resolve();
function apply() {
  applying = applying.then(applyNow, applyNow);
  applying.then(scheduleReport, scheduleReport);
  return applying;
}

async function applyNow() {
  const st = await getState();
  const servers = activeServers(st);
  indexCreds(servers);
  if (!st.enabled || !servers.length) {
    if (FIREFOX) route = null;
    else await B.proxy.settings.clear({ scope: 'regular' });
    await webrtc(false);
    if (st.error && st.subUrl) await badge('!', '#d93025');
    else if (updateOf(st)) await badge('NEW', '#2f6fe4');
    else await badge('', '');
    return;
  }
  if (FIREFOX) {
    route = routeContext(st, servers, false);
    await webrtc(true);
    await badge('ON', '#1f9d6a');
    return;
  }
  const cur = await B.proxy.settings.get({});
  if (cur.levelOfControl === 'not_controllable' || cur.levelOfControl === 'controlled_by_other_extensions') {
    await setState({
      error:
        cur.levelOfControl === 'not_controllable'
          ? 'Прокси в этом браузере задаёт политика организации - расширение не может его включить'
          : 'Прокси уже задаёт другое расширение - выключите его',
    });
    await badge('!', '#d93025');
    return;
  }
  const pac = (priming) =>
    B.proxy.settings.set({
      value: { mode: 'pac_script', pacScript: { data: buildPac(st, servers, priming), mandatory: true } },
      scope: 'regular',
    });
  // сначала пароль, потом трафик: без пароля прокси прикидывается сайтом и страница не откроется
  // ждём прогрева не дольше 3 секунд: недоступный сервер из списка догреется в фоне (или не
  // догреется - Chrome уйдёт на следующий), а страницы не должны стоять
  await webrtc(true);
  await pac(true);
  await Promise.race([prime(servers, true), new Promise((r) => setTimeout(r, 3000))]);
  await pac(false);
  if (updateOf(st)) await badge('NEW', '#2f6fe4');
  else await badge('ON', '#1f9d6a');
}

/** Номер этой установки (случайный): по нему панель отличает браузеры одного человека. */
async function installId() {
  const st = await getState();
  if (st.install) return st.install;
  const id = [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('');
  await setState({ install: id });
  return id;
}

/**
 * Отчёт панели о себе: версия, браузер, включён ли прокси, выбранный сервер и ошибка в окне -
 * при каждом изменении и раз в 15 минут (по нему в панели видно, что расширение работает). Ни
 * адресов страниц, ни трафика. Не дошёл - не страшно, будет следующий.
 */
let reportTimer = null;
function scheduleReport() {
  clearTimeout(reportTimer);
  reportTimer = setTimeout(() => report().catch(() => {}), 1500);
}
async function report() {
  const st = await getState();
  if (!st.subUrl) return;
  const failed = st.enabled && st.check && !st.check.ok ? `проверка выхода: ${st.check.error || 'не прошла'}` : '';
  await fetch(`${st.subUrl}/status`, {
    method: 'POST',
    cache: 'no-store',
    credentials: 'omit',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      install: await installId(),
      version: B.runtime.getManifest().version,
      browser: FIREFOX ? 'firefox' : 'chrome',
      enabled: Boolean(st.enabled && activeServers(st).length),
      server: String(st.server || 'auto').slice(0, 64),
      error: String(st.error || failed).slice(0, 300),
    }),
  });
}

// Firefox: куда идёт запрос. route - данные маршрутизации (null - прокси выключен). Пока фон
// после запуска браузера не прочитал настройки, запросы ждут (иначе первые ушли бы мимо прокси).
let route = null;
let ready = Promise.resolve();

/** Пароль к прокси заголовком Basic (логин и пароль - UTF-8). */
function basic(s) {
  const bytes = new TextEncoder().encode(`${s.user}:${s.pass}`);
  return `Basic ${btoa(String.fromCharCode(...bytes))}`;
}

/** Ответ PAC ("DIRECT" или "HTTPS имя:порт; ...") -> ProxyInfo Firefox с паролями. */
function proxyInfo(answer) {
  if (answer === 'DIRECT') return { type: 'direct' };
  const list = [];
  for (const part of answer.split(';')) {
    const m = /^\s*HTTPS\s+(\S+):(\d+)\s*$/.exec(part);
    if (!m) continue;
    const s = creds && creds.get(`${m[1]}:${m[2]}`);
    if (!s) continue;
    list.push({
      type: 'https',
      host: m[1],
      port: Number(m[2]),
      proxyAuthorizationHeader: basic(s),
      // недоступный сервер - через 5 секунд следующий из цепочки
      failoverTimeout: 5,
    });
  }
  // ни одного прокси не собралось - не пускать мимо, а отказать
  return list.length ? list : { type: 'https', host: '127.0.0.1', port: 9 };
}

if (FIREFOX) {
  browser.proxy.onRequest.addListener(
    async (d) => {
      await ready;
      if (!route) return { type: 'direct' };
      let host = '';
      try {
        host = new URL(d.url).hostname;
      } catch {
        return { type: 'direct' };
      }
      return proxyInfo(pacRoute(d.url, host, route));
    },
    { urls: ['<all_urls>'] },
  );
}

let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    const st = await getState();
    if (!st.subUrl) return;
    try {
      // заголовок: эта версия шлёт отчёты сама (панель не путает её со старой)
      const r = await fetch(st.subUrl, {
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'x-vps-ext': await installId() },
      });
      if (r.status === 404) {
        await setState({ sub: null, error: 'Ссылка больше не действует: возьмите новую на личной странице' });
        return;
      }
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const sub = await r.json();
      if (!sub || !Array.isArray(sub.servers)) throw new Error('неверный ответ');
      const patch = {
        sub,
        fetchedAt: new Date().toISOString(),
        error: sub.suspended
          ? 'Доступ приостановлен'
          : sub.servers.length
            ? ''
            : 'Серверов для браузера пока нет - загляните позже',
      };
      if (st.server !== 'auto' && !sub.servers.some((s) => s.id === st.server)) patch.server = 'auto';
      await setState(patch);
    } catch (e) {
      // сеть или сервер подписок недоступны - работаем на прежнем списке
      await setState({ error: `Подписка не обновилась: ${e.message}` });
    }
  })().finally(async () => {
    refreshing = null;
    await apply();
  });
  return refreshing;
}

/**
 * Пинг сервера: время запроса к его странице-заглушке по тому же входу, что у прокси (первый
 * порт: 443 или свой). Первый запрос - с DNS и TLS, следующие идут по тому же соединению и
 * близки к времени пути туда и обратно; берётся лучший из трёх. null - сервер не ответил.
 */
async function ping(s) {
  const port = s.ports[0];
  const base = `https://${s.host}${port === 443 ? '' : `:${port}`}/`;
  let best = null;
  for (let i = 0; i < 3; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4000);
    const t0 = performance.now();
    try {
      await fetch(`${base}?t=${Date.now()}${i}`, { cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      const ms = Math.round(performance.now() - t0);
      best = best === null ? ms : Math.min(best, ms);
    } catch {
      if (best === null) return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return best;
}

/** Работает ли выход: запрос через прокси к странице 204 Google. */
async function check() {
  const st = await getState();
  if (!st.enabled || !activeServers(st).length) return null;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12_000);
  const started = Date.now();
  let res;
  try {
    const r = await fetch(`https://www.gstatic.com/generate_204?t=${started}`, {
      cache: 'no-store',
      credentials: 'omit',
      signal: ctl.signal,
    });
    res = { ok: r.status === 204, ms: Date.now() - started, at: new Date().toISOString() };
  } catch (e) {
    res = { ok: false, error: ctl.signal.aborted ? 'нет ответа' : 'нет соединения через прокси', at: new Date().toISOString() };
  } finally {
    clearTimeout(timer);
  }
  await setState({ check: res });
  scheduleReport();
  return res;
}

// Chrome: пароль к прокси и восстановление после его сброса (в Firefox пароль идёт заголовком).
if (!FIREFOX) {
  // Пароль к прокси. Повтор по тому же запросу - пароль не подошёл: отмена и обновление подписки
  // (выдали новую ссылку или пароль сменился), иначе Chrome спрашивал бы по кругу.
  const tries = new Map();
  B.webRequest.onAuthRequired.addListener(
    (d, done) => {
      if (!d.isProxy) return done({});
      (async () => {
        if (!creds) indexCreds(activeServers(await getState()));
        const s = creds.get(`${d.challenger.host}:${d.challenger.port}`);
        const n = (tries.get(d.requestId) || 0) + 1;
        tries.set(d.requestId, n);
        if (tries.size > 500) tries.clear();
        if (!s || n > 2) {
          if (s) refresh();
          return done({ cancel: true });
        }
        done({ authCredentials: { username: s.user, password: s.pass } });
      })();
    },
    { urls: ['<all_urls>'] },
    ['asyncBlocking'],
  );

  // Страница не открылась из-за прокси (пароль сброшен - смена сети, перезапуск) - прогрев и одна
  // перезагрузка вкладки.
  const reloaded = new Map();
  B.webRequest.onErrorOccurred.addListener(
    (d) => {
      if (d.type !== 'main_frame' || !/TUNNEL_CONNECTION_FAILED|PROXY_AUTH|PROXY_CONNECTION_FAILED/.test(d.error))
        return;
      (async () => {
        const st = await getState();
        if (!st.enabled) return;
        await applying;
        await Promise.race([prime(activeServers(st), false), new Promise((r) => setTimeout(r, 3000))]);
        if (d.tabId >= 0 && Date.now() - (reloaded.get(d.tabId) || 0) > 60_000) {
          reloaded.set(d.tabId, Date.now());
          B.tabs.reload(d.tabId).catch(() => {});
        }
      })();
    },
    { urls: ['<all_urls>'] },
  );
}

/**
 * Firefox: ссылку берём с открытой личной страницы - подписанный архив один на всех, своей
 * ссылки в нём нет. Имя страниц (firefox.json) зашито при сборке: чужие сайты не подходят.
 */
async function linkFromTabs() {
  let host = '';
  try {
    host = (await (await fetch(B.runtime.getURL('firefox.json'))).json()).subHost || '';
  } catch {}
  if (!host) return null;
  for (const t of await B.tabs.query({})) {
    try {
      const u = new URL(t.url || '');
      if (u.hostname === host && subscriptionUrl(u.href)) return u.href;
    } catch {}
  }
  return null;
}

async function setLink(link) {
  const url = subscriptionUrl(link);
  if (!url) return { error: 'Это не ссылка VPS Panel: нужна ссылка личной страницы или подписки' };
  await setState({ subUrl: url, sub: null, error: '', server: 'auto' });
  await refresh();
  const st = await getState();
  if (activeServers(st).length && !st.enabled) {
    await setState({ enabled: true });
    await apply();
  }
  return {};
}

B.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    switch (msg && msg.cmd) {
      case 'setLink':
        return setLink(msg.link);
      case 'toggle':
        await setState({ enabled: Boolean(msg.on), check: null });
        await apply();
        return {};
      case 'server':
        await setState({ server: String(msg.id || 'auto'), check: null });
        await apply();
        return {};
      case 'ru':
        await setState({ ruDirect: Boolean(msg.on) });
        await apply();
        return {};
      case 'direct': {
        // свои адреса напрямую: с ошибками не сохраняем - список в окне остаётся для правки
        const text = String(msg.text || '').slice(0, 20000);
        const r = parseDirect(text);
        if (r.errors.length) return { directErrors: r.errors };
        const prev = (await getState()).directText;
        await setState({ directText: text });
        try {
          await apply();
        } catch (e) {
          await setState({ directText: prev });
          await apply().catch(() => {});
          return { directErrors: [`не применилось: ${e.message}`] };
        }
        return { directSaved: r.count };
      }
      case 'refresh':
        await refresh();
        return {};
      case 'auto': {
        // окно без ссылки: в Firefox - поискать открытую личную страницу
        const st = await getState();
        if (st.subUrl || !FIREFOX) return {};
        const link = await linkFromTabs();
        return link ? setLink(link) : {};
      }
      case 'check':
        return { check: await check() };
      case 'pings': {
        const servers = activeServers(await getState());
        const res = await Promise.all(servers.map(async (s) => [s.id, await ping(s)]));
        return { pings: Object.fromEntries(res) };
      }
      case 'download': {
        const u = updateOf(await getState());
        if (u && /^https:\/\//.test(u.download)) await B.tabs.create({ url: u.download });
        return {};
      }
      case 'restart':
        // перечитать файлы с диска: после распаковки нового архива поверх папки
        setTimeout(() => B.runtime.reload(), 100);
        return {};
      case 'forget':
        await B.storage.local.clear();
        await apply();
        return {};
      default:
        return {};
    }
  })()
    .then(async (r) => {
      const state = await getState();
      reply({ ...(r || {}), state, update: updateOf(state), current: B.runtime.getManifest().version });
    })
    .catch((e) => reply({ error: e.message }));
  return true;
});

function alarms() {
  B.alarms.create('refresh', { periodInMinutes: 12 * 60 });
  B.alarms.create('prime', { periodInMinutes: 15 });
  B.alarms.create('status', { periodInMinutes: 15 });
}
B.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'refresh') refresh();
  if (a.name === 'status') report().catch(() => {});
  if (a.name === 'prime' && !FIREFOX) {
    const st = await getState();
    if (st.enabled) prime(activeServers(st), true);
  }
});

// Установка: ссылка из config.json архива (Chrome: панель кладёт туда подписку клиента) или с
// открытой личной страницы (Firefox).
B.runtime.onInstalled.addListener(async () => {
  alarms();
  const st = await getState();
  if (!st.subUrl) {
    try {
      const cfg = await (await fetch(B.runtime.getURL('config.json'))).json();
      if (cfg && cfg.subscription) {
        await setLink(cfg.subscription);
        return;
      }
    } catch {}
    const link = FIREFOX ? await linkFromTabs() : null;
    if (link) {
      await setLink(link);
      return;
    }
  }
  await refresh();
});
B.runtime.onStartup.addListener(() => {
  alarms();
  refresh();
});

// Firefox: фоновая страница живёт всё время работы браузера - маршрут из сохранённых настроек
// сразу при запуске (запросы до этого ждут ready)
if (FIREFOX) ready = apply().catch(() => {});

// для проверки на стенде (Playwright)
self.vps = { getState, refresh, apply, check, report, subscriptionUrl, buildPac };
