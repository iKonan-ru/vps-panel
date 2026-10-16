import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { actionLog } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { type TermPeer, TermSessions } from '../lib/term-sessions.js';
import { foreignOrigin, sessionOf, sessionToken } from './auth.js';

/** Код закрытия сокета, которым браузер просит закрыть сессию сразу ("Закрыть"). */
const CLOSE_EXPLICIT = 4000;

/**
 * /ws/term/:serverId - веб-терминал: браузер <-> панель (websocket) <-> агент (term.*).
 * Вывод агента (base64) пересылается как есть, ввод и размер уходят отдельными запросами.
 * Сессия живёт на панели и без браузера ещё 3 минуты: `?sid=` её
 * подхватывает. Каждая сессия пишется в журнал действий (когда открыли и закрыли).
 */
export async function terminalRoutes(
  app: FastifyInstance,
  opts: { db: Db; registry: AgentRegistry },
) {
  const { db, registry } = opts;
  const sessions = new TermSessions((s) => {
    registry
      .request(s.serverId, 'term.close', { id: s.sid }, { timeoutMs: 10_000 })
      .catch(() => undefined);
  });

  app.get('/ws/term/:serverId', { websocket: true }, async (socket, req) => {
    const auth = await sessionOf(db, sessionToken(req));
    if (!auth) return socket.close(4001, 'unauthorized');
    if (foreignOrigin(req)) return socket.close(4003, 'foreign origin');
    const { serverId } = req.params as { serverId: string };
    if (!registry.isOnline(serverId)) return socket.close(4009, 'agent offline');
    // браузер ушёл, пока проверялась сессия: 'close' уже был, сессию не начинаем
    if (socket.readyState !== socket.OPEN) return;
    const url = new URL(req.url, 'http://x');
    const cols = Math.min(Math.max(Number(url.searchParams.get('cols')) || 120, 20), 400);
    const rows = Math.min(Math.max(Number(url.searchParams.get('rows')) || 32, 5), 200);
    const wanted = url.searchParams.get('sid') ?? '';

    const peer: TermPeer = {
      send: (o) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(o));
      },
      close: (code, reason) => socket.close(code, reason),
    };

    let s = wanted ? sessions.resumable(wanted, serverId, auth.login) : null;
    if (s) {
      peer.send({ t: 'session', sid: s.sid, resumed: true });
      sessions.attach(s, peer);
      registry
        .request(serverId, 'term.resize', { id: s.sid, cols, rows }, { timeoutMs: 10_000 })
        .catch(() => undefined);
    } else {
      const sid = newId();
      const created = sessions.create(sid, serverId, auth.login, peer);
      s = created;
      peer.send({ t: 'session', sid, resumed: false });
      const actionId = newId();
      // синхронно: обработчик закрытия сокета ниже должен появиться до любого await
      db.insert(actionLog)
        .values({ id: actionId, serverId, kind: 'terminal', params: { login: auth.login } })
        .run();
      registry
        .request(
          serverId,
          'term.open',
          { id: sid, cols, rows },
          {
            timeoutMs: 24 * 60 * 60_000,
            onStream: (_channel, chunk) => sessions.output(created, chunk),
          },
        )
        .then((r) => {
          created.peer?.send({ t: 'exit', code: (r as { exitCode?: number })?.exitCode ?? 0 });
          created.peer?.close(1000, 'shell exited');
        })
        .catch((e: Error) => {
          created.peer?.send({ t: 'error', m: e.message });
          created.peer?.close(1011, 'agent error');
        })
        .finally(() => {
          sessions.end(created);
          const kb = Math.round((created.total * 3) / 4 / 1024);
          db.update(actionLog)
            .set({
              finishedAt: new Date().toISOString(),
              exitCode: 0,
              output: `Терминал закрыт, передано ${kb} КБ вывода`,
            })
            .where(eq(actionLog.id, actionId))
            .run();
        });
    }
    const session = s;

    // Ввод - строго по порядку: агент выполняет запросы параллельно, и нажатия, отправленные
    // каждое своим запросом, приходили бы в терминал вперемешку ("clear" -> "clesar"). Пока один
    // запрос в пути, следующие нажатия копятся и уходят одним куском после его ответа.
    let queued: Buffer[] = [];
    let sending = false;
    const flush = () => {
      if (sending || !queued.length) return;
      const data = Buffer.concat(queued).toString('base64');
      queued = [];
      sending = true;
      registry
        .request(serverId, 'term.input', { id: session.sid, data }, { timeoutMs: 10_000 })
        .catch(() => undefined)
        .finally(() => {
          sending = false;
          flush();
        });
    };

    socket.on('message', (raw) => {
      let m: { t: string; d?: string; cols?: number; rows?: number };
      try {
        m = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (session.peer !== peer) return;
      if (m.t === 'input' && typeof m.d === 'string') {
        queued.push(Buffer.from(m.d, 'base64'));
        flush();
      } else if (m.t === 'resize' && m.cols && m.rows) {
        registry
          .request(
            serverId,
            'term.resize',
            { id: session.sid, cols: m.cols, rows: m.rows },
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined);
      }
    });
    socket.on('close', (code) => sessions.detach(session, peer, code === CLOSE_EXPLICIT));
  });
}
