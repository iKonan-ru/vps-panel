import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, createDb } from '../src/db/index.js';
import { XuiLinkWatch } from '../src/lib/gclients.js';
import { vlessLinkPrint } from '../src/lib/xui-api.js';

/** VLESS Reality inbound 3X-UI: streamSettings строкой, как у старых версий. */
const inbound = (sni: string, extra: Record<string, unknown> = {}) => ({
  id: 1,
  port: 443,
  enable: true,
  protocol: 'vless',
  remark: 'VLESS',
  streamSettings: JSON.stringify({
    network: 'tcp',
    security: 'reality',
    realitySettings: { serverNames: [sni], shortIds: ['ab'], settings: { publicKey: 'pk' } },
  }),
  ...extra,
});

describe('vlessLinkPrint', () => {
  it('меняется от того, из чего собраны ссылки, а не от трафика и чужих inbound-ов', () => {
    const a = vlessLinkPrint([inbound('a.example.com')]);
    expect(vlessLinkPrint([inbound('a.example.com', { up: 100, down: 5 })])).toBe(a);
    expect(vlessLinkPrint([inbound('a.example.com'), { id: 2, protocol: 'vmess', port: 1 }])).toBe(
      a,
    );
    expect(vlessLinkPrint([inbound('b.example.com')])).not.toBe(a);
    expect(vlessLinkPrint([inbound('a.example.com', { port: 8443 })])).not.toBe(a);
  });
});

let dir: string;
let db: Db;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'watch-'));
  db = createDb(dir);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('XuiLinkWatch', () => {
  it('первый отпечаток запоминается, смена цели Reality - синхронизация сервера', () => {
    let kicks = 0;
    const w = new XuiLinkWatch(db, { kick: () => void kicks++ });
    w.note('s1', [inbound('a.example.com')]);
    w.note('s1', [inbound('a.example.com')]);
    expect(kicks).toBe(0);
    w.note('s1', [inbound('b.example.com')]);
    expect(kicks).toBe(1);
    w.note('s2', [inbound('b.example.com')]);
    expect(kicks).toBe(1);
  });
});
