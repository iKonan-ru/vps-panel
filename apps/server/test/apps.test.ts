import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { AppReleases } from '../src/lib/apps.js';

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'apps-'));
  db = createDb(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const rel = (tag: string, names: string[], prerelease = false) => ({
  tag_name: tag,
  html_url: `https://github.com/x/releases/tag/${tag}`,
  published_at: '2026-09-01T00:00:00Z',
  draft: false,
  prerelease,
  assets: names.map((n) => ({ name: n, browser_download_url: `https://dl/${tag}/${n}`, size: 1 })),
});

describe('AppReleases', () => {
  it('файл - из самого свежего релиза, где он есть; pre-release пропускается; нет - страница релиза', async () => {
    let fail = false;
    const fetchOut = async (url: string) => {
      if (fail) throw new Error('сеть');
      if (url.includes('amnezia-client'))
        return new Response(
          JSON.stringify([
            rel('5.0.4.0-beta', ['AmneziaVPN_5.0.4.0_android11+_arm64-v8a.apk'], true),
            rel('5.0.3.1', ['AmneziaVPN_5.0.3.1_windows_x64.exe']),
            rel('5.0.3.0', [
              'AmneziaVPN_5.0.3.0_android11+_arm64-v8a.apk',
              'AmneziaVPN_5.0.3.0_windows_x64.exe',
            ]),
          ]),
        );
      return new Response('[]');
    };
    const a = new AppReleases(db, fetchOut, { warn: () => {} });
    await a.refresh();
    const vpn = a.list().apps.find((x) => x.id === 'amnezia-vpn');
    const link = (os: string) => vpn?.platforms.find((p) => p.os === os)?.links[0];
    expect(link('android')).toMatchObject({
      version: '5.0.3.0',
      url: 'https://dl/5.0.3.0/AmneziaVPN_5.0.3.0_android11+_arm64-v8a.apk',
    });
    expect(link('windows')).toMatchObject({ version: '5.0.3.1' });
    expect(link('macos')).toMatchObject({
      note: 'файл не найден - страница релиза',
      version: '5.0.3.1',
    });
    // сбой сети не стирает найденное
    fail = true;
    await a.refresh();
    expect(a.list().apps.find((x) => x.id === 'amnezia-vpn')?.platforms[0]?.links[0]).toMatchObject(
      { version: '5.0.3.0' },
    );
  });
});

describe('AppReleases: лимит GitHub', () => {
  it('на исчерпанном лимите обход останавливается, причина видна в ссылке', async () => {
    let calls = 0;
    const fetchOut = async () => {
      calls++;
      return new Response('{"message":"API rate limit exceeded"}', {
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
      });
    };
    const a = new AppReleases(db, fetchOut, { warn: () => {} });
    await a.refresh();
    expect(calls).toBe(1);
    const apk = a.list().apps.find((x) => x.id === 'happ')?.platforms[0]?.links[0];
    expect(apk?.note).toContain('лимит запросов GitHub исчерпан');
    // кнопка сразу после проверки GitHub не спрашивает
    await a.refresh(false);
    expect(calls).toBe(1);
  });
});
