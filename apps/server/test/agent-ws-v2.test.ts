import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  verify,
} from 'node:crypto';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { servers } from '../src/db/schema.js';
import { HANDSHAKE_CONTEXT, panelKey, proof, transcript } from '../src/lib/agent-channel.js';
import { sha256 } from '../src/lib/auth.js';

// Сторона агента канала v2 - как apps/agent/internal/transport (secure.go, client.go).
const X25519_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED25519_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const nonce = (seq: number) => {
  const n = Buffer.alloc(12);
  n.writeBigUInt64BE(BigInt(seq), 4);
  return n;
};

const dir = mkdtempSync(join(tmpdir(), 'vps-agentws-'));
const env = loadEnv({ NODE_ENV: 'test', DATA_DIR: dir });
let built: Awaited<ReturnType<typeof buildApp>>;
let url = '';

beforeAll(async () => {
  built = await buildApp({ env, db: createDb(':memory:') });
  built.db
    .insert(servers)
    .values({
      id: 's1',
      name: 's1',
      host: '1.1.1.1',
      // в базе - хеш одноразового токена и срок
      registrationToken: sha256('regtoken'),
      registrationExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    } as never)
    .run();
  built.db
    .insert(servers)
    .values({
      id: 's2',
      name: 's2',
      host: '1.1.1.2',
      registrationToken: sha256('expired-token'),
      registrationExpiresAt: new Date(Date.now() - 1000).toISOString(),
    } as never)
    .run();
  const addr = await built.app.listen({ port: 0, host: '127.0.0.1' });
  url = `${addr.replace('http', 'ws')}/ws/agent?v=2`;
});
afterAll(async () => {
  await built.app.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Агент: рукопожатие, auth и hello; возвращает welcome, сокет и шифрование. */
async function agent(credential: string, opts: { reg?: string; tamper?: boolean } = {}) {
  const ws = new WebSocket(url);
  const queue: { data: Buffer; binary: boolean }[] = [];
  const waiters: ((m: { data: Buffer; binary: boolean }) => void)[] = [];
  let closed: number | null = null;
  ws.on('message', (data, binary) => {
    const m = { data: data as Buffer, binary };
    const w = waiters.shift();
    if (w) w(m);
    else queue.push(m);
  });
  ws.on('close', (code) => {
    closed = code;
  });
  const next = () =>
    new Promise<{ data: Buffer; binary: boolean } | null>((resolve) => {
      const q = queue.shift();
      if (q) return resolve(q);
      waiters.push(resolve);
      setTimeout(() => resolve(null), 2000);
    });
  await new Promise((r) => ws.once('open', r));
  const eph = generateKeyPairSync('x25519');
  const ephA = Buffer.from(eph.publicKey.export({ type: 'spki', format: 'der' }).subarray(12));
  ws.send(JSON.stringify({ type: 'hello2', eph: ephA.toString('base64') }));
  const sh = JSON.parse(String((await next())?.data));
  const ephP = Buffer.from(sh.eph, 'base64');
  const key = Buffer.from(sh.key, 'base64');
  const th = transcript(ephA, ephP, key);
  const pub = createPublicKey({
    key: Buffer.concat([ED25519_SPKI, key]),
    format: 'der',
    type: 'spki',
  });
  const sigOk = verify(null, th, pub, Buffer.from(sh.sig, 'base64'));
  const shared = diffieHellman({
    privateKey: eph.privateKey,
    publicKey: createPublicKey({
      key: Buffer.concat([X25519_SPKI, ephP]),
      format: 'der',
      type: 'spki',
    }),
  });
  const k = Buffer.from(
    hkdfSync('sha256', shared, Buffer.concat([ephA, ephP]), HANDSHAKE_CONTEXT, 64),
  );
  let sendSeq = 0;
  let recvSeq = 0;
  const seal = (obj: unknown) => {
    const c = createCipheriv('aes-256-gcm', k.subarray(0, 32), nonce(sendSeq++));
    const body = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
    return Buffer.concat([body, c.getAuthTag()]);
  };
  const open = (b: Buffer) => {
    const d = createDecipheriv('aes-256-gcm', k.subarray(32), nonce(recvSeq++));
    d.setAuthTag(b.subarray(b.length - 16));
    return JSON.parse(
      Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]).toString(),
    );
  };
  const credHash = sha256(credential);
  const auth: Record<string, unknown> = { type: 'auth', proof: proof(credHash, 'agent', th) };
  if (opts.reg) Object.assign(auth, { reg: true, tokenHash: sha256(opts.reg) });
  ws.send(seal(auth));
  const host = {
    hostname: 'h',
    os: 'linux',
    kernel: '6',
    arch: 'amd64',
    cpuCores: 1,
    agentVersion: '0.3.0',
    publicIp: '1.1.1.1',
  };
  const hello = seal({ type: 'hello', protocol: '1.0', host, methods: ['inventory.get'] });
  if (opts.tamper) hello[0] = (hello[0] ?? 0) ^ 1;
  ws.send(hello);
  const w = await next();
  const welcome = w?.binary ? open(w.data) : null;
  return { ws, welcome, sigOk, th, credHash, key, closed: () => closed, next, open, seal };
}

describe('канал агента v2', () => {
  it('ключ панели создаётся один раз с правами 600', () => {
    const a = panelKey(dir);
    expect(a.pub).toHaveLength(32);
    expect(statSync(join(dir, 'panel_agent_ed25519.pem')).mode & 0o777).toBe(0o600);
  });

  it('просроченный токен регистрации не подходит', async () => {
    const a = await agent('expired-token', { reg: 'whatever-token' });
    expect(a.welcome).toBeNull();
    a.ws.close();
  });

  it('регистрация: подпись панели, доказательство в welcome, у панели - только хеш токена', async () => {
    const a = await agent('regtoken', { reg: 'agent-made-token' });
    expect(a.sigOk).toBe(true);
    expect(a.key.toString('base64')).toBe(panelKey(dir).b64);
    expect(a.welcome?.type).toBe('welcome');
    expect(a.welcome?.serverId).toBe('s1');
    expect(a.welcome?.token).toBeUndefined();
    expect(a.welcome?.proof).toBe(proof(a.credHash, 'panel', a.th));
    const row = built.db
      .select()
      .from(servers)
      .all()
      .find((r) => r.id === 's1');
    expect(row?.agentTokenHash).toBe(sha256('agent-made-token'));
    expect(row?.registrationToken).toBeNull();
    expect(built.registry.isOnline('s1')).toBe(true);
    // запросы панели (снимок при подключении и наш) приходят зашифрованными и находят ответ
    const req = built.registry.request('s1', 'inventory.get', {}, { timeoutMs: 3000 });
    for (let i = 0; i < 2; i++) {
      let msg: { type?: string; id?: string; method?: string } | null = null;
      while (msg?.type !== 'request') {
        const m = await a.next();
        if (!m) break;
        msg = a.open(m.data);
      }
      expect(msg?.method).toBe('inventory.get');
      a.ws.send(a.seal({ type: 'result', id: msg?.id, ok: false, error: 'проверка' }));
    }
    await expect(req).rejects.toThrow('проверка');
    a.ws.close();
  });

  it('обработчик online может сразу писать агенту: welcome уходит первым', async () => {
    // агент рвёт связь, если запрос панели пришёл до welcome (так панель потеряла все агенты)
    const onOnline = (id: string) => {
      if (id === 's1')
        void built.registry.request('s1', 'inventory.get', {}, { timeoutMs: 500 }).catch(() => {});
    };
    built.registry.on('online', onOnline);
    try {
      const a = await agent('agent-made-token');
      expect(a.welcome?.type).toBe('welcome');
      a.ws.close();
    } finally {
      built.registry.off('online', onOnline);
    }
  });

  it('повторное подключение постоянным токеном', async () => {
    const a = await agent('agent-made-token');
    expect(a.welcome?.proof).toBe(proof(sha256('agent-made-token'), 'panel', a.th));
    a.ws.close();
  });

  it('чужой токен - отказ без welcome', async () => {
    const a = await agent('wrong');
    expect(a.welcome).toBeNull();
    await new Promise((r) => setTimeout(r, 50));
    expect(a.closed()).toBe(4003);
  });

  it('подменённый кадр рвёт соединение', async () => {
    const a = await agent('agent-made-token', { tamper: true });
    expect(a.welcome).toBeNull();
    a.ws.close();
  });

  it('стенограмма считается одинаково с агентом', () => {
    const t = transcript(Buffer.alloc(32, 1), Buffer.alloc(32, 2), Buffer.alloc(32, 3));
    const want = createHash('sha256')
      .update(Buffer.concat([Buffer.from(`${HANDSHAKE_CONTEXT}\0`), Buffer.alloc(32, 1)]))
      .update(Buffer.concat([Buffer.alloc(32, 2), Buffer.alloc(32, 3)]))
      .digest();
    expect(t.equals(want)).toBe(true);
  });
});
