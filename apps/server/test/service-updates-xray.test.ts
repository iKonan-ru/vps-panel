import type { ServiceUpdate } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import type { Action } from '../src/lib/action-journal.js';
import { SecretBox } from '../src/lib/secret-box.js';
import { ServiceUpdates } from '../src/lib/service-updates.js';

/** 3X-UI через агента: версия Xray, список версий, которые он умеет ставить, установка. */
function fake3xui(state: { xray: string; offered: string[]; installs: string[]; panel?: string }) {
  return {
    isOnline: () => true,
    request: async (_id: string, method: string, p: { method: string; path: string }) => {
      if (method === 'xui.token') return { token: 't' };
      if (method !== 'xui.api') throw new Error(`неожиданный вызов ${method}`);
      const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });
      if (p.path === 'server/getPanelUpdateInfo')
        return ok({
          currentVersion: state.panel ?? '3.9.0',
          latestVersion: state.panel ?? '3.9.0',
          updateAvailable: false,
        });
      if (p.path === 'server/status')
        return ok({ xray: { state: 'running', version: state.xray } });
      if (p.path === 'server/getXrayVersion') return ok(state.offered);
      if (p.path.startsWith('server/installXray/')) {
        const tag = p.path.slice('server/installXray/'.length);
        state.installs.push(tag);
        state.xray = tag.replace(/^v/, '');
        return ok(null);
      }
      throw new Error(`неожиданный путь ${p.path}`);
    },
  } as unknown as AgentRegistry;
}

function setup(state: { xray: string; offered: string[]; installs: string[] }) {
  const db = createDb(':memory:');
  const inventory = { services: [{ kind: 'xui', title: '3X-UI', version: '3.9.0', ports: [] }] };
  db.insert(servers)
    .values({ id: 's1', name: 's1', host: 'h', statusCache: { inventory } } as never)
    .run();
  const sent: ServiceUpdate[] = [];
  const u = new ServiceUpdates(
    db,
    new SecretBox('x'.repeat(32)),
    fake3xui(state),
    { warn: () => {} },
    async (_id, x) => {
      sent.push(x);
    },
    async () => {
      throw new Error('GitHub не нужен');
    },
  );
  return { u, sent, db };
}

describe('ServiceUpdates: Xray в 3X-UI', () => {
  it('3X-UI поставили заново с новым Xray - старая строка "обновить Xray" не висит', async () => {
    const state = {
      xray: '26.9.30',
      offered: ['v26.10.10', 'v26.9.30'],
      installs: [] as string[],
      panel: '3.9.0',
    };
    const { u, db } = setup(state);
    expect((await u.recheck('s1')).map((x) => x.kind)).toEqual(['xray']);
    // переустановка ОС и 3X-UI 3.10.0 со своим Xray 26.10.10: проверки по расписанию ещё не было
    state.xray = '26.10.10';
    state.panel = '3.10.0';
    const inventory = {
      services: [{ kind: 'xui', title: '3X-UI', version: '3.10.0', ports: [] }],
    };
    db.update(servers)
      .set({ statusCache: { inventory } } as never)
      .run();
    expect(await u.list('s1')).toEqual([]);
    // в блоке "Версии" - без "v" у тега и без кнопки: это уже не обновление
    const v = await u.versions('s1', ['xui', 'xray']);
    expect(v.xray?.available).toBe(false);
    expect(v.xray?.latest).toBe('26.10.10');
    // перепроверка запущена сама: после неё обновления тоже нет
    await new Promise((r) => setTimeout(r, 20));
    expect(await u.recheck('s1')).toEqual([]);
  });

  it('новейшая из предложенных 3X-UI - обновление; ставится и пропадает', async () => {
    const state = {
      xray: '26.9.30',
      offered: ['v26.10.10', 'v26.9.30', 'v26.6.27'],
      installs: [] as string[],
    };
    const { u, sent } = setup(state);
    const list = await u.recheck('s1');
    expect(list.map((x) => `${x.kind} ${x.current} -> ${x.latest}`)).toEqual([
      'xray 26.9.30 -> 26.10.10',
    ]);
    expect(sent.map((x) => x.title)).toEqual(['Xray']);

    const log: string[] = [];
    let code = -1;
    const action = {
      id: 'a',
      output: '',
      stream: (_c: string, t: string) => log.push(t),
      finish: async (c: number) => {
        code = c;
      },
    } as Action;
    await u.installXray('s1', action);
    expect(state.installs).toEqual(['v26.10.10']);
    expect(code).toBe(0);
    expect(await u.list('s1')).toEqual([]);
  });

  it('стоит новейшая из предложенных - обновления нет', async () => {
    const state = {
      xray: '26.10.10',
      offered: ['v26.9.30', 'v26.10.10'],
      installs: [] as string[],
    };
    const { u, sent } = setup(state);
    expect(await u.recheck('s1')).toEqual([]);
    expect(sent).toEqual([]);
  });
});
