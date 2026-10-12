import { existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { PanelUpdates, compareVersions } from '../src/lib/panel-updates.js';

const releases = [
  { tag_name: 'v1.1.0-beta.1', prerelease: true },
  { tag_name: 'v1.0.1', prerelease: false },
  { tag_name: 'v1.0.0', prerelease: false },
  { tag_name: 'v0.9.0-beta.1', prerelease: true },
  { tag_name: 'nightly', prerelease: true },
  { tag_name: 'v2.0.0', prerelease: false, draft: true },
].map((r) => ({
  draft: false,
  html_url: `https://github.com/x/releases/${r.tag_name}`,
  published_at: '2026-10-12T00:00:00Z',
  body: `изменения ${r.tag_name}`,
  ...r,
}));

function make(current: string, managed = true) {
  const dir = mkdtempSync(join(tmpdir(), 'vps-upd-'));
  if (managed) mkdirSync(join(dir, 'update'));
  const seen: string[] = [];
  const u = new PanelUpdates(
    createDb(':memory:'),
    dir,
    async () => new Response(JSON.stringify(releases), { status: 200 }),
    { warn: () => undefined },
    async (r) => {
      seen.push(r.version);
    },
    current,
  );
  return { u, dir, seen };
}

describe('обновления панели', () => {
  it('сравнение версий: бета младше релиза той же версии', () => {
    expect(compareVersions('1.0.0', '1.0.0-beta.3')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0-beta.10', '1.0.0-beta.9')).toBeGreaterThan(0);
    expect(compareVersions('1.1.0-beta.1', '1.0.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('dev', '1.0.0')).toBeLessThan(0);
  });

  it('новые версии по каналу; уведомление - один раз на версию', async () => {
    const { u, seen } = make('1.0.0');
    await u.refresh();
    expect(u.newer().map((r) => r.version)).toEqual(['1.0.1']);
    u.saveSettings({ channel: 'beta' });
    expect(u.newer().map((r) => r.version)).toEqual(['1.1.0-beta.1', '1.0.1']);
    expect(u.newer()[0]?.notes).toBe('изменения v1.1.0-beta.1');
    await u.refresh();
    await u.refresh();
    expect(seen).toEqual(['1.0.1', '1.1.0-beta.1']);
  });

  it('запрос службе на хосте: только новая известная версия и только установка из релиза', async () => {
    const { u, dir } = make('1.0.0');
    await u.refresh();
    await expect(u.request('0.9.0-beta.1')).rejects.toThrow(/нет среди новых/);
    await expect(u.request('1.1.0-beta.1')).rejects.toThrow(/нет среди новых/);
    await u.request('1.0.1');
    const f = join(dir, 'update', 'request.json');
    expect(JSON.parse(readFileSync(f, 'utf8')).version).toBe('1.0.1');
    expect(u.view().requested).toBe('1.0.1');

    const src = make('dev', false);
    await src.u.refresh();
    expect(src.u.managed).toBe(false);
    await expect(src.u.request('1.0.1')).rejects.toThrow(/не из релиза/);
    expect(existsSync(join(src.dir, 'update'))).toBe(false);
  });

  it('смена версии с прошлого запуска - один раз, первый запуск не считается', () => {
    const db = createDb(':memory:');
    const mk = (v: string) =>
      new PanelUpdates(
        db,
        '/nonexistent',
        fetch,
        { warn: () => undefined },
        async () => undefined,
        v,
      );
    expect(mk('1.0.0').versionChanged()).toBe(false);
    expect(mk('1.0.0').versionChanged()).toBe(false);
    expect(mk('1.0.1').versionChanged()).toBe(true);
    expect(mk('1.0.1').versionChanged()).toBe(false);
  });

  it('канал по умолчанию - канал установки (install --beta), пока владелец не выбрал свой', () => {
    const db = createDb(':memory:');
    const mk = (ch: 'stable' | 'beta') =>
      new PanelUpdates(
        db,
        '/nonexistent',
        fetch,
        { warn: () => undefined },
        async () => undefined,
        '1.0.0',
        ch,
      );
    expect(mk('beta').settings().channel).toBe('beta');
    expect(mk('stable').settings().channel).toBe('stable');
    mk('beta').saveSettings({ channel: 'stable' });
    expect(mk('beta').settings().channel).toBe('stable');
  });
});
