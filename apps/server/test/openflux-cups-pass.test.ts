import { describe, expect, it } from 'vitest';
import type { AgentRegistry } from '../src/agents/registry.js';
import { createDb } from '../src/db/index.js';
import { gclientBindings, gclients, servers } from '../src/db/schema.js';
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
    // Avito на этом проходе не отказывал - у второго канала его комнаты по-прежнему просятся
    expect(calls.map((x) => x.avito)).toEqual(['auto', '']);
    expect(pass.cupsOff).toBe(true);
    expect(first.warning).toContain('cups.online');
    expect(second.warning).toContain('ограничил частоту');
    expect(second.links).toEqual(['openflux://x']);
  });

  it('выданный канал без Avito (вариант б): перенастройка с новыми транспортами и новая ссылка', async () => {
    const calls: Record<string, unknown>[] = [];
    let link = 0;
    const registry = {
      request: async (_id: string, method: string, params: Record<string, unknown>) => {
        if (method === 'openflux.link') return { link: `openflux://new-${++link}` };
        calls.push(params);
        return { cupsonline: true, avito: false };
      },
    } as unknown as AgentRegistry;
    const db = createDb(':memory:');
    db.insert(servers).values({ id: 's1', name: 'S', host: '1.2.3.4' }).run();
    db.insert(gclients).values({ id: 'c1', name: 'Иван', token: 't', slug: 'ivan-1' }).run();
    db.insert(gclientBindings)
      .values({ id: 'vp-4', clientId: 'c1', serverId: 's1', service: 'openflux', ref: 'vp-4' })
      .run();
    const { addOfDocs } = await import('../src/lib/openflux-docs.js');
    addOfDocs(
      db,
      'https://telemost.yandex.ru/j/12345678901234\nhttps://boards.yandex.ru/whiteboard/?utm=1&hash=0123456789abcdef0123456789abcdef',
    );
    const deps = { db, box: new SecretBox('x'.repeat(32)), registry };
    const row = { id: 's1', name: 'Hoster', host: '1.1.1.1', provider: '', country: '' } as never;
    const st = {
      channels: [
        {
          channel: 'vp-4',
          enabled: true,
          transports: [{ type: 'direct' }, { type: 'cupsonline' }],
        },
      ],
    } as never;
    const pass = { cupsOff: false, avitoOff: false };
    const r = await ofEnsure(
      deps,
      row,
      st,
      { enabled: true } as never,
      { id: 'vp-4', ref: 'vp-4', links: ['openflux://old'], secret: '' } as never,
      pass,
    );
    expect(calls).toEqual([
      {
        op: 'configure',
        channel: 'vp-4',
        vyandex: '',
        mailru: '',
        telemost: 'https://telemost.yandex.ru/j/12345678901234',
        boards: 'https://boards.yandex.ru/whiteboard/?hash=0123456789abcdef0123456789abcdef',
        cupsonline: 'keep',
        avito: 'auto',
      },
    ]);
    expect(r.links).toEqual(['openflux://new-1']);
    // Avito не выдал комнат - причина в warning, на проходе больше не просить
    expect(r.warning).toContain('Avito');
    expect(pass.avitoOff).toBe(true);
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
                transports: [{ type: 'direct' }, { type: 'cupsonline' }, { type: 'avito' }],
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
