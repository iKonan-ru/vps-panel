import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Фон расширения (apps/extension/bg.js) в режиме Firefox на имитации API browser.*: ссылка с
 * открытой личной страницы при установке, решение по каждому запросу (proxy.onRequest) с паролем
 * в заголовке, выключение.
 */
const ext = join(__dirname, '../../extension');
const token = 'a'.repeat(32);
const sub = {
  name: 'Иван',
  suspended: false,
  servers: [
    {
      id: 's1',
      title: 'SE :: Hoster',
      host: 'hoster.example.com',
      ports: [443, 8444],
      user: 'ivan-1',
      pass: 'Пароль1',
      probe: 'aa.test',
    },
  ],
};

function load(tabs: string[]) {
  const store: Record<string, unknown> = {};
  const listeners: Record<string, (...a: unknown[]) => unknown> = {};
  const on = (name: string) => ({
    addListener: (f: (...a: unknown[]) => unknown) => {
      listeners[name] = f;
    },
  });
  const fetched: string[] = [];
  const reports: Record<string, unknown>[] = [];
  const browser = {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]])),
        set: async (p: Record<string, unknown>) => void Object.assign(store, p),
        clear: async () => {
          for (const k of Object.keys(store)) delete store[k];
        },
      },
    },
    runtime: {
      getManifest: () => ({ version: '1.4.0' }),
      getURL: (p: string) => `moz-extension://x/${p}`,
      onMessage: on('message'),
      onInstalled: on('installed'),
      onStartup: on('startup'),
    },
    proxy: { onRequest: on('request') },
    privacy: {
      network: { webRTCIPHandlingPolicy: { set: async () => {}, clear: async () => {} } },
    },
    browserAction: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    alarms: { create: () => {}, onAlarm: on('alarm') },
    tabs: {
      query: async () => tabs.map((url) => ({ url })),
      create: async () => {},
      reload: async () => {},
    },
  };
  const fetch = async (url: string, init?: { method?: string; body?: string }) => {
    fetched.push(url);
    if (url === `https://sub.example.com/sub/${token}/browser/status` && init?.method === 'POST') {
      reports.push(JSON.parse(init.body ?? '{}'));
      return { ok: true, status: 204 };
    }
    if (url === 'moz-extension://x/firefox.json')
      return { ok: true, status: 200, json: async () => ({ subHost: 'sub.example.com' }) };
    if (url === `https://sub.example.com/sub/${token}/browser`)
      return { ok: true, status: 200, json: async () => sub };
    throw new Error(`нет такого адреса: ${url}`);
  };
  const ctx = createContext({
    browser,
    fetch,
    URL,
    TextEncoder,
    btoa,
    AbortController,
    setTimeout,
    clearTimeout,
    performance,
    console,
    crypto,
  });
  ctx.self = ctx;
  runInContext(readFileSync(join(ext, 'rules.js'), 'utf8'), ctx);
  runInContext(readFileSync(join(ext, 'bg.js'), 'utf8'), ctx);
  const route = (url: string) =>
    (listeners.request as (d: { url: string }) => Promise<unknown>)({ url });
  return { store, listeners, route, fetched, reports };
}

const auth = `Basic ${Buffer.from('ivan-1:Пароль1').toString('base64')}`;

describe('расширение в Firefox', () => {
  it('установка: ссылка с открытой личной страницы, прокси сразу включён, пароль в заголовке', async () => {
    const b = load([
      `https://evil.example/c/${'b'.repeat(32)}`,
      `https://sub.example.com/c/${token}`,
    ]);
    expect(await b.route('https://example.com/')).toEqual({ type: 'direct' });
    await (b.listeners.installed as () => Promise<void>)();
    expect(b.store.subUrl).toBe(`https://sub.example.com/sub/${token}/browser`);
    expect(b.store.enabled).toBe(true);
    const p = (await b.route('https://example.com/')) as Record<string, unknown>[];
    expect(p).toEqual([
      {
        type: 'https',
        host: 'hoster.example.com',
        port: 443,
        proxyAuthorizationHeader: auth,
        failoverTimeout: 5,
      },
      {
        type: 'https',
        host: 'hoster.example.com',
        port: 8444,
        proxyAuthorizationHeader: auth,
        failoverTimeout: 5,
      },
    ]);
    expect(await b.route('https://ya.ru/')).toEqual({ type: 'direct' });
    expect(await b.route(`https://sub.example.com/c/${token}`)).toEqual({ type: 'direct' });
    expect(await b.route('https://hoster.example.com/')).toEqual({ type: 'direct' });
    // выключили - всё напрямую
    await new Promise<void>((resolve) =>
      (b.listeners.message as (m: unknown, s: unknown, r: () => void) => void)(
        { cmd: 'toggle', on: false },
        {},
        resolve,
      ),
    );
    expect(await b.route('https://example.com/')).toEqual({ type: 'direct' });
    // отчёт панели о себе - после изменений, с паузой 1,5 с
    await new Promise((r) => setTimeout(r, 1700));
    expect(b.reports.at(-1)).toEqual({
      install: b.store.install,
      version: '1.4.0',
      browser: 'firefox',
      enabled: false,
      server: 'auto',
      error: '',
    });
    expect(String(b.store.install)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('чужие страницы ссылку не дают', async () => {
    const b = load([`https://evil.example/c/${token}`]);
    await (b.listeners.installed as () => Promise<void>)();
    expect(b.store.subUrl).toBeUndefined();
    expect(b.fetched).not.toContain(`https://evil.example/sub/${token}/browser`);
  });
});
