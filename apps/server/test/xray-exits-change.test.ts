import type { XrayOutbound } from '@vps/protocol';
import { describe, expect, it } from 'vitest';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { SecretBox } from '../src/lib/secret-box.js';
import {
  exitsAfterInboundChange,
  exitsAfterServerRemoved,
  telegramExitOf,
} from '../src/lib/xray-exits.js';
import { saveXuiToken } from '../src/lib/xui-token.js';

const reality = (port: number, network = 'tcp') =>
  JSON.stringify({
    network,
    security: 'reality',
    realitySettings: {
      serverNames: ['google.com'],
      shortIds: ['ab'],
      settings: { publicKey: 'PUB', fingerprint: 'firefox' },
    },
  });

const exit = (serverId: string, inboundId: number, port: number): XrayOutbound => ({
  serverId,
  serverName: serverId === 's1' ? 'Hoster' : 'NetCore',
  inboundId,
  inboundRemark: 'VLESS',
  address: '203.0.113.10',
  port,
  uuid: 'u',
  publicKey: 'PUB',
  shortId: 'ab',
  sni: 'google.com',
  fingerprint: 'firefox',
  flow: '',
  updatedAt: '2020',
});

/** Сервер s1 с 3X-UI (inbound-ы в памяти), основной выход на s1, запасной на s2. */
async function setup(inbounds: Record<string, unknown>[], spares: XrayOutbound[] = []) {
  const db = createDb(':memory:');
  const box = new SecretBox('s'.repeat(40));
  db.insert(servers)
    .values({
      id: 's1',
      name: 'Hoster',
      host: '203.0.113.10',
      statusCache: { inventory: { services: [{ kind: 'xui' }] } },
    } as never)
    .run();
  await saveXuiToken(db, box, 's1', 'tok');
  const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });
  const registry = {
    isOnline: () => true,
    request: async (_id: string, _m: string, p: { path: string }) => {
      if (p.path === 'inbounds/list') return ok(inbounds);
      if (p.path.startsWith('inbounds/get/'))
        return ok(inbounds.find((i) => i.id === Number(p.path.split('/')[2])) ?? null);
      if (p.path === 'clients/get/vps-panel')
        return ok({ client: { uuid: 'u', email: 'vps-panel' }, inboundIds: [1, 5] });
      return ok(null);
    },
  };
  let exits: XrayOutbound[] = [exit('s1', 1, 28512), ...spares];
  const saved: (XrayOutbound | null)[] = [];
  const life: string[] = [];
  let syncs = 0;
  const xray = {
    exits: () => exits,
    status: () => ({
      exits: exits.map((x, i) => ({ ...x, lastCheck: i === 2 ? { ok: true } : { ok: false } })),
    }),
    save: async (ob: XrayOutbound | null) => {
      saved.push(ob);
      exits = ob ? [ob] : [];
    },
    start: async () => void life.push('start'),
    stop: async () => void life.push('stop'),
  };
  const deps = {
    db,
    box,
    registry: registry as never,
    xray: xray as never,
    log: { info: () => {}, warn: () => {} },
    panelUrl: 'https://panel.example.com',
  };
  const spareSync = { sync: async () => void syncs++ };
  return { deps, spareSync, saved, life, syncs: () => syncs };
}

describe('выходы в Telegram за inbound-ами', () => {
  it('удалён inbound основного - на другой RAW этого сервера (не XHTTP)', async () => {
    const t = await setup([
      {
        id: 4,
        remark: 'XHTTP',
        enable: true,
        protocol: 'vless',
        port: 8443,
        streamSettings: reality(8443, 'xhttp'),
      },
      {
        id: 5,
        remark: 'VLESS 2',
        enable: true,
        protocol: 'vless',
        port: 30225,
        streamSettings: reality(30225),
      },
    ]);
    const notes = await exitsAfterInboundChange(t.deps, t.spareSync, 's1', 1, true);
    expect(t.saved[0]).toMatchObject({ serverId: 's1', inboundId: 5, port: 30225 });
    expect(notes[0]).toMatch(/VLESS 2/);
    expect(t.life).toEqual(['start']);
    expect(t.syncs()).toBe(1);
  });

  it('другого нет - на запасной, чья проверка прошла', async () => {
    const t = await setup([], [exit('s2', 3, 15262), exit('s3', 9, 28512)]);
    const notes = await exitsAfterInboundChange(t.deps, t.spareSync, 's1', 1, true);
    expect(t.saved[0]).toMatchObject({ serverId: 's3', inboundId: 9 });
    expect(notes[0]).toMatch(/на запасной/);
  });

  it('ни другого, ни запасных - основной снимается', async () => {
    const t = await setup([]);
    const notes = await exitsAfterInboundChange(t.deps, t.spareSync, 's1', 1, true);
    expect(t.saved).toEqual([null]);
    expect(t.life).toEqual(['stop']);
    expect(notes[0]).toMatch(/снят/);
  });

  it('порт inbound-а основного сменился - снимок заново; чужой inbound - только запасные', async () => {
    const t = await setup([
      {
        id: 1,
        remark: 'VLESS',
        enable: true,
        protocol: 'vless',
        port: 40000,
        streamSettings: reality(40000),
      },
    ]);
    await exitsAfterInboundChange(t.deps, t.spareSync, 's1', 1, false);
    expect(t.saved[0]).toMatchObject({ inboundId: 1, port: 40000 });
    await exitsAfterInboundChange(t.deps, t.spareSync, 's1', 77, true);
    expect(t.saved).toHaveLength(1);
    expect(t.syncs()).toBe(2);
  });

  it('сервер основного выхода удалён из панели - на запасной, чья проверка прошла', async () => {
    const t = await setup([], [exit('s2', 3, 15262), exit('s3', 9, 28512)]);
    await exitsAfterServerRemoved(t.deps, t.spareSync, 's1');
    expect(t.saved[0]).toMatchObject({ serverId: 's3', inboundId: 9 });
    expect(t.syncs()).toBe(1);
    await exitsAfterServerRemoved(t.deps, t.spareSync, 's2');
    expect(t.saved).toHaveLength(1);
  });

  it('метка выхода в списке inbound-ов', () => {
    const ex = [exit('s1', 1, 1), exit('s2', 3, 1)];
    expect(telegramExitOf(ex, 's1', 1)).toBe('primary');
    expect(telegramExitOf(ex, 's2', 3)).toBe('spare');
    expect(telegramExitOf(ex, 's1', 3)).toBeNull();
  });
});

describe('запасные выходы: выбор владельца', () => {
  it('выключенные серверы запасными не берутся, остальные и новые - да', async () => {
    const { XraySpares } = await import('../src/lib/xray-exits.js');
    const { setSpareOff } = await import('../src/lib/xray.js');
    const db = createDb(':memory:');
    const box = new SecretBox('s'.repeat(40));
    for (const [id, host] of [
      ['s1', '203.0.113.10'],
      ['s2', '203.0.113.20'],
      ['s3', '203.0.113.30'],
      ['s4', '203.0.113.40'],
    ] as const) {
      db.insert(servers)
        .values({
          id,
          name: id,
          host,
          statusCache: { inventory: { services: [{ kind: 'xui' }] } },
        } as never)
        .run();
      await saveXuiToken(db, box, id, 'tok');
    }
    const ok = (obj: unknown) => ({ status: 200, data: { success: true, obj } });
    const inbound = {
      id: 1,
      remark: 'VLESS',
      enable: true,
      protocol: 'vless',
      port: 443,
      streamSettings: reality(443),
    };
    const registry = {
      isOnline: () => true,
      request: async (_id: string, _m: string, p: { path: string }) => {
        if (p.path === 'inbounds/list') return ok([inbound]);
        if (p.path.startsWith('inbounds/get/')) return ok(inbound);
        if (p.path === 'clients/get/vps-panel')
          return ok({ client: { uuid: 'u', email: 'vps-panel' }, inboundIds: [1] });
        return ok(null);
      },
    };
    let spares: XrayOutbound[] = [];
    const xray = {
      status: () => ({ outbound: exit('s1', 1, 443) }),
      exits: () => [exit('s1', 1, 443), ...spares],
      setSpares: async (l: XrayOutbound[]) => {
        spares = l;
        return false;
      },
      start: async () => {},
      checkAll: async () => [],
    };
    const s = new XraySpares({
      db,
      box,
      registry: registry as never,
      xray: xray as never,
      log: { info: () => {}, warn: () => {} },
      panelUrl: 'http://127.0.0.1',
    });
    await s.sync();
    expect(spares.map((x) => x.serverId)).toEqual(['s2', 's3', 's4']);
    setSpareOff(db, ['s3', 's3']);
    await s.sync();
    expect(spares.map((x) => x.serverId)).toEqual(['s2', 's4']);
  });
});
