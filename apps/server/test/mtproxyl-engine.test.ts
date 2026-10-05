import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { EngineCatalog } from '../src/lib/mtproxyl-engine.js';

/** Агент: engine versions MTProxyL (носитель, текущая версия, релизы telemt). */
const agent = (v: { current: string; binary: boolean }) =>
  ({
    request: async (_id: string, method: string, p: { op?: string }) => {
      if (method !== 'mtproxyl.exec' || p.op !== 'engine.versions') throw new Error(method);
      return {
        output: JSON.stringify({
          ...v,
          releases: [
            { tag: '3.5.12', date: '2026-10-02' },
            { tag: '3.5.11', date: '2026-10-01' },
            { tag: '3.5.9', date: '2026-09-28 (pre-release)' },
            { tag: '3.5.7', date: '2026-09-08' },
          ],
        }),
      };
    },
  }) as unknown as AgentRegistry;

/** Реестр: готовые образы есть у 3.5.11, 3.5.9 и 3.5.7; у свежей 3.5.12 ещё нет. */
let calls = 0;
const fetchOut = async (url: string) => {
  calls++;
  if (url.includes('/token')) return new Response(JSON.stringify({ token: 't' }));
  if (url.includes('/tags/list'))
    return new Response(
      JSON.stringify({ tags: ['latest', '3.5.11-94f4f7d', '3.5.9-e3f62db', '3.5.7-4ca7418'] }),
    );
  return new Response(
    JSON.stringify([
      { tag_name: '3.5.12', target_commitish: 'aaaaaaa1111' },
      { tag_name: '3.5.11', target_commitish: '94f4f7d0000' },
      { tag_name: '3.5.9', target_commitish: 'e3f62db0000' },
      { tag_name: '3.5.7', target_commitish: '4ca7418' },
    ]),
  );
};

describe('EngineCatalog', () => {
  it('docker: ставится только версия с готовым образом', async () => {
    calls = 0;
    const c = new EngineCatalog(agent({ current: '3.5.7-4ca7418', binary: false }), fetchOut);
    const info = await c.info('s1');
    expect(info.current).toBe('3.5.7');
    expect(info.versions.map((v) => [v.tag, v.ready, v.installed])).toEqual([
      ['3.5.12', false, false],
      ['3.5.11', true, false],
      ['3.5.9', true, false],
      ['3.5.7', true, true],
    ]);
    expect(info.versions[2]).toMatchObject({ prerelease: true, date: '2026-09-28' });
    // реестр и GitHub - раз в час на все серверы
    await c.info('s2');
    expect(calls).toBe(3);
  });

  it('бинарник скачивается готовым: ставится любая версия, реестр не спрашиваем', async () => {
    calls = 0;
    const info = await new EngineCatalog(agent({ current: '3.5.11', binary: true }), fetchOut).info(
      's1',
    );
    expect(info.versions.every((v) => v.ready)).toBe(true);
    expect(calls).toBe(0);
  });

  it('реестр не ответил: версии docker не ставятся, причина видна', async () => {
    const info = await new EngineCatalog(
      agent({ current: '3.5.7-4ca7418', binary: false }),
      async () => new Response('', { status: 503 }),
    ).info('s1');
    expect(info.registryError).toContain('503');
    expect(info.versions.some((v) => v.ready)).toBe(false);
  });
});
