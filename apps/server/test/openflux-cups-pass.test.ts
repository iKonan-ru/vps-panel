import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { ofEnsure } from '../src/lib/gclient-services.js';
import { SecretBox } from '../src/lib/secret-box.js';

describe('ofEnsure: cups.online отказал на проходе', () => {
  it('следующие каналы создаются без комнат сразу, с причиной в warning', async () => {
    const calls: Record<string, unknown>[] = [];
    const registry = {
      request: async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === 'openflux.link') return { link: 'openflux://x' };
        calls.push(params);
        // комнат нет: cups.online ограничил частоту
        return { cupsonline: false };
      },
    } as unknown as AgentRegistry;
    const deps = { db: createDb(':memory:'), box: new SecretBox('x'.repeat(32)), registry };
    const row = { id: 's1', name: 'Hoster', host: '1.1.1.1', provider: '', country: '' } as never;
    const c = { enabled: true } as never;
    const pass = { cupsOff: false };
    const b = (ref: string) => ({ id: ref, ref, links: [], secret: '' }) as never;
    const first = await ofEnsure(deps, row, { channels: [] } as never, c, b('vp-1'), pass);
    const second = await ofEnsure(deps, row, { channels: [] } as never, c, b('vp-2'), pass);
    expect(calls.map((x) => x.cupsonline)).toEqual(['auto', '']);
    expect(pass.cupsOff).toBe(true);
    expect(first.warning).toContain('cups.online');
    expect(second.warning).toContain('ограничил частоту');
    expect(second.links).toEqual(['openflux://x']);
  });

  it('канал появился после снимка ("уже есть на сервере") - дальше как с существующим', async () => {
    const ops: string[] = [];
    const registry = {
      request: async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === 'openflux.link') return { link: 'openflux://y' };
        if (method === 'openflux.status')
          return {
            channels: [
              {
                channel: 'vp-3',
                enabled: true,
                transports: [{ type: 'direct' }, { type: 'cupsonline' }],
              },
            ],
          };
        ops.push(String(params.op));
        if (params.op === 'create') throw new Error('канал vp-3 уже есть на сервере');
        return {};
      },
    } as unknown as AgentRegistry;
    const deps = { db: createDb(':memory:'), box: new SecretBox('x'.repeat(32)), registry };
    const row = { id: 's1', name: 'Hoster', host: '1.1.1.1', provider: '', country: '' } as never;
    const r = await ofEnsure(
      deps,
      row,
      { channels: [] } as never,
      { enabled: true } as never,
      { id: 'vp-3', ref: 'vp-3', links: [], secret: '' } as never,
    );
    expect(ops).toEqual(['create']);
    expect(r.links).toEqual(['openflux://y']);
  });
});
