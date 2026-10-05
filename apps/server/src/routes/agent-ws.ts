import { timingSafeEqual } from 'node:crypto';
import type { EventEmitter } from 'node:events';
import {
  type AgentHello,
  AgentHelloSchema,
  PROTOCOL_VERSION,
  type PanelMessage,
  isCompatible,
} from '@vps/protocol';
import { and, eq, gt, isNotNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import type { AgentRegistry, AgentSocket } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import {
  SecureAgentSocket,
  panelKey,
  proof,
  serverHandshake,
  toBuffer,
} from '../lib/agent-channel.js';

/**
 * Очередь сообщений сокета на время рукопожатия: агент шлёт auth и hello подряд, и пока панель
 * проверяет первое (запрос к базе), второе не должно пропасть без слушателя.
 */
class Inbox {
  private queue: string[] = [];
  private waiter: ((m: string | null) => void) | null = null;
  private readonly on = (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const m = toBuffer(raw).toString();
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w(m);
    } else this.queue.push(m);
  };
  constructor(private sock: EventEmitter) {
    sock.on('message', this.on);
  }
  next(timeoutMs = 10_000): Promise<string | null> {
    const q = this.queue.shift();
    if (q !== undefined) return Promise.resolve(q);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.waiter = null;
        resolve(null);
      }, timeoutMs);
      this.waiter = (m) => {
        clearTimeout(t);
        resolve(m);
      };
    });
  }
  /** Рукопожатие закончено: дальше сообщения слушает реестр. */
  stop() {
    this.sock.off('message', this.on);
  }
}

function parseJson(s: string | null): unknown {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const Hello2Schema = z.object({ type: z.literal('hello2'), eph: z.string().max(64) });
const AuthSchema = z.object({
  type: z.literal('auth'),
  proof: z.string().max(64),
  reg: z.boolean().optional(),
  tokenHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/**
 * /ws/agent (`?v=2`): рукопожатие с ключом панели и шифрованный канал (lib/agent-channel.ts),
 * токен по сети не ходит - агент доказывает знание его хеша.
 */
export async function agentWsRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry; dataDir: string },
) {
  const { db, registry, dataDir } = opts;
  const key = panelKey(dataDir);

  /** Общая часть после проверки учётных данных: hello, версия, реестр, welcome. */
  async function attach(
    sock: AgentSocket,
    serverId: string,
    hello: AgentHello,
    extra: Partial<PanelMessage & { type: 'welcome' }>,
  ) {
    await db
      .update(servers)
      .set({ agentVersion: hello.host.agentVersion, lastSeenAt: new Date().toISOString() })
      .where(eq(servers.id, serverId));
    registry.attach({ serverId, ws: sock, methods: hello.methods });
    const welcome: PanelMessage = {
      type: 'welcome',
      serverId,
      protocol: PROTOCOL_VERSION,
      ...extra,
    };
    sock.send(JSON.stringify(welcome));
    // Сразу просим полный снимок; дальше агент шлёт его сам раз в 5 минут.
    void registry.refreshInventory(serverId);
  }

  function readHello(raw: string | null) {
    const hello = AgentHelloSchema.safeParse(parseJson(raw));
    if (!hello.success) return { error: 'bad hello' as const };
    if (!isCompatible(hello.data.protocol)) return { error: 'protocol' as const };
    return { hello: hello.data };
  }

  async function secure(socket: WebSocket) {
    const raw = new Inbox(socket);
    const h = Hello2Schema.safeParse(parseJson(await raw.next()));
    raw.stop();
    if (!h.success) return socket.close(4002, 'bad hello2');
    const ephA = Buffer.from(h.data.eph, 'base64');
    if (ephA.length !== 32) return socket.close(4002, 'bad hello2');
    const { reply, channel, th } = serverHandshake(ephA, key);
    socket.send(JSON.stringify(reply));
    const sock = new SecureAgentSocket(socket, channel);
    const inbox = new Inbox(sock);

    const auth = AuthSchema.safeParse(parseJson(await inbox.next()));
    if (!auth.success) return socket.close(4002, 'bad auth');
    const a = auth.data;
    // строк мало (серверы): перебираем и сверяем доказательство с хешем каждого токена
    let serverId: string | null = null;
    let credHash = '';
    let reg: string | null = null;
    if (a.reg) {
      if (!a.tokenHash) return socket.close(4002, 'bad auth');
      // в базе - sha256 одноразового токена и срок; просроченный не подходит
      const rows = await db
        .select({ id: servers.id, reg: servers.registrationToken })
        .from(servers)
        .where(
          and(
            isNotNull(servers.registrationToken),
            gt(servers.registrationExpiresAt, new Date().toISOString()),
          ),
        );
      for (const r of rows) {
        if (r.reg && same(proof(r.reg, 'agent', th), a.proof)) {
          serverId = r.id;
          credHash = r.reg;
          reg = r.reg;
        }
      }
    } else {
      const rows = await db
        .select({ id: servers.id, hash: servers.agentTokenHash })
        .from(servers)
        .where(isNotNull(servers.agentTokenHash));
      for (const r of rows) {
        if (r.hash && same(proof(r.hash, 'agent', th), a.proof)) {
          serverId = r.id;
          credHash = r.hash;
        }
      }
    }
    if (!serverId) return socket.close(4003, 'bad token');

    const res = readHello(await inbox.next());
    inbox.stop();
    if (res.error === 'bad hello') return socket.close(4002, 'bad hello');
    if (res.error) return socket.close(4004, `protocol ${PROTOCOL_VERSION} required`);

    if (reg && a.tokenHash) {
      // постоянный токен создал агент, у нас - только его хеш; условие на одноразовый: второй
      // агент с тем же одноразовым токеном не зарегистрируется
      const done = db
        .update(servers)
        .set({ agentTokenHash: a.tokenHash, registrationToken: null, registrationExpiresAt: null })
        .where(and(eq(servers.id, serverId), eq(servers.registrationToken, reg)))
        .run();
      if (done.changes !== 1) return socket.close(4003, 'bad registration token');
    }
    await attach(sock as unknown as AgentSocket, serverId, res.hello, {
      proof: proof(credHash, 'panel', th),
    });
  }

  app.get('/ws/agent', { websocket: true }, async (socket, req) => {
    if ((req.query as { v?: string }).v === '2') return secure(socket);
    // без v=2 - не наш агент или слишком старый: переустановка (команда - в карточке сервера)
    return socket.close(4006, 'agent too old: reinstall');
  });
}
