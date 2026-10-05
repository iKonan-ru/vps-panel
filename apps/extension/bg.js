// Фон расширения. Подписка /sub/<токен>/browser даёт серверы: имя,
// порты, логин, пароль, секретное имя. По ним - PAC (chrome.proxy), пароль к прокси
// (onAuthRequired) и прогрев пароля: прокси с probe_resistance без пароля прикидывается сайтом и
// пароль не спрашивает, поэтому расширение само идёт на секретное имя - там прокси отвечает 407,
// Chrome запоминает пароль и дальше шлёт его сам в каждом запросе.

importScripts('rules.js'); // parseDirect, buildPac

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
};

async function getState() {
  return { ...DEF, ...(await chrome.storage.local.get(Object.keys(DEF))) };
}
const setState = (patch) => chrome.storage.local.set(patch);

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
  const e = st.sub && st.sub.extension;
  return e && e.version && newer(e.version, chrome.runtime.getManifest().version) ? e : null;
}

async function badge(text, color) {
  await chrome.action.setBadgeText({ text });
  if (color) await chrome.action.setBadgeBackgroundColor({ color });
}

async function webrtc(on) {
  // WebRTC мимо прокси показал бы настоящий адрес
  try {
    if (on)
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({ value: 'disable_non_proxied_udp' });
    else await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
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
  return applying;
}

async function applyNow() {
  const st = await getState();
  const servers = activeServers(st);
  indexCreds(servers);
  if (!st.enabled || !servers.length) {
    await chrome.proxy.settings.clear({ scope: 'regular' });
    await webrtc(false);
    if (st.error && st.subUrl) await badge('!', '#d93025');
    else if (updateOf(st)) await badge('NEW', '#2f6fe4');
    else await badge('', '');
    return;
  }
  const cur = await chrome.proxy.settings.get({});
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
    chrome.proxy.settings.set({
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

let refreshing = null;
function refresh() {
  refreshing ??= (async () => {
    const st = await getState();
    if (!st.subUrl) return;
    try {
      const r = await fetch(st.subUrl, { cache: 'no-store', credentials: 'omit' });
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
  return res;
}

// Пароль к прокси. Повтор по тому же запросу - пароль не подошёл: отмена и обновление подписки
// (выдали новую ссылку или пароль сменился), иначе Chrome спрашивал бы по кругу.
const tries = new Map();
chrome.webRequest.onAuthRequired.addListener(
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
chrome.webRequest.onErrorOccurred.addListener(
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
        chrome.tabs.reload(d.tabId).catch(() => {});
      }
    })();
  },
  { urls: ['<all_urls>'] },
);

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

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
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
      case 'check':
        return { check: await check() };
      case 'pings': {
        const servers = activeServers(await getState());
        const res = await Promise.all(servers.map(async (s) => [s.id, await ping(s)]));
        return { pings: Object.fromEntries(res) };
      }
      case 'download': {
        const u = updateOf(await getState());
        if (u && /^https:\/\//.test(u.download)) await chrome.tabs.create({ url: u.download });
        return {};
      }
      case 'restart':
        // перечитать файлы с диска: после распаковки нового архива поверх папки
        setTimeout(() => chrome.runtime.reload(), 100);
        return {};
      case 'forget':
        await chrome.storage.local.clear();
        await apply();
        return {};
      default:
        return {};
    }
  })()
    .then(async (r) => {
      const state = await getState();
      reply({ ...(r || {}), state, update: updateOf(state), current: chrome.runtime.getManifest().version });
    })
    .catch((e) => reply({ error: e.message }));
  return true;
});

function alarms() {
  chrome.alarms.create('refresh', { periodInMinutes: 12 * 60 });
  chrome.alarms.create('prime', { periodInMinutes: 15 });
}
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name === 'refresh') refresh();
  if (a.name === 'prime') {
    const st = await getState();
    if (st.enabled) prime(activeServers(st), true);
  }
});

// Установка: ссылка из config.json архива (панель кладёт туда подписку клиента).
chrome.runtime.onInstalled.addListener(async () => {
  alarms();
  const st = await getState();
  if (!st.subUrl) {
    try {
      const cfg = await (await fetch(chrome.runtime.getURL('config.json'))).json();
      if (cfg && cfg.subscription) {
        await setLink(cfg.subscription);
        return;
      }
    } catch {}
  }
  await refresh();
});
chrome.runtime.onStartup.addListener(() => {
  alarms();
  refresh();
});

// для проверки на стенде (Playwright)
self.vps = { getState, refresh, apply, check, subscriptionUrl, buildPac };
