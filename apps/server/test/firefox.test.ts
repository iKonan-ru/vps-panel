import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { firefoxXpi } from '../src/lib/extension.js';
import { FirefoxSigner, firefoxDirs } from '../src/lib/firefox.js';
import { SecretBox } from '../src/lib/secret-box.js';

describe('расширение Firefox', () => {
  it('архив - самый новый из каталогов панели и прежней раскладки', () => {
    const root = mkdtempSync(join(tmpdir(), 'vps-ff-'));
    const env = { DATA_DIR: join(root, 'data'), FILES_DIR: join(root, 'files') };
    expect(firefoxXpi(firefoxDirs(env))).toBeNull();
    mkdirSync(join(env.FILES_DIR, 'firefox'), { recursive: true });
    writeFileSync(join(env.FILES_DIR, 'firefox', 'vps-panel-proxy-1.5.0.xpi'), 'old');
    expect(firefoxXpi(firefoxDirs(env))).toBe(
      join(env.FILES_DIR, 'firefox', 'vps-panel-proxy-1.5.0.xpi'),
    );
    mkdirSync(join(env.DATA_DIR, 'firefox'), { recursive: true });
    writeFileSync(join(env.DATA_DIR, 'firefox', 'vps-panel-proxy-1.10.0.xpi'), 'new');
    expect(firefoxXpi(firefoxDirs(env))).toBe(
      join(env.DATA_DIR, 'firefox', 'vps-panel-proxy-1.10.0.xpi'),
    );
  });

  it('ID и ключ: свой у панели, ключ хранится зашифрованным, без ключа подписи нет', async () => {
    const db = createDb(':memory:');
    const env = {
      DATA_DIR: mkdtempSync(join(tmpdir(), 'vps-ff-')),
      FILES_DIR: '/nonexistent',
      PANEL_PUBLIC_URL: 'https://panel.example.com',
      SUB_DOMAIN: 'sub.example.com',
      EXTENSION_DIR: resolve('../extension'),
    };
    const f = new FirefoxSigner(db, new SecretBox('x'.repeat(32)), env as never, {
      warn: () => undefined,
      info: () => undefined,
    });
    expect(f.view()).toMatchObject({ keySet: false, id: 'vps-panel-proxy@panel.example.com' });
    expect(f.view().version).toMatch(/^\d+\.\d+/);
    await expect(f.sign()).rejects.toThrow(/не задан ключ/);
    await f.ensure();
    f.setKey({ issuer: 'user:1:2', secret: 'abc' });
    expect(f.view().keySet).toBe(true);
    const raw = db.$client.prepare("select value from setting where key = 'firefox_amo'").get() as {
      value: string;
    };
    expect(raw.value).not.toContain('abc');
    f.setKey(null);
    expect(f.view().keySet).toBe(false);
  });
});
