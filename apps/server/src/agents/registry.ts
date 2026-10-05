import { EventEmitter } from 'node:events';
import type { AgentMessage, AgentMethod, Inventory, Metrics, PanelMessage } from '@vps/protocol';
import { AgentMessageSchema, InventorySchema } from '@vps/protocol';
import { newId } from '../lib/ids.js';

/**
 * Ошибка вызова агента - ответ для человека, а не сбой панели: с кодом, общий обработчик отдаёт
 * её текст ("Агент не ответил вовремя", ошибку сервиса), а не "Внутренняя ошибка".
 */
const agentError = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { statusCode });

/** Агент не знает операции: её нет в списке из hello (или агент ответил, что не умеет). */
export const AGENT_OUTDATED = 'Агент устарел: обнови его кнопкой "Обновить агента"';

/**
 * Соединение с агентом, как его видит реестр: SecureAgentSocket (lib/agent-channel.ts) -
 * 'message' приходит уже расшифрованным; в тестах - имитация websocket.
 */
export interface AgentSocket {
  send(data: string, cb?: (err?: Error) => void): void;
  close(code?: number, reason?: string): void;
  ping(): void;
  terminate(): void;
  on(event: 'message', listener: (raw: Buffer) => void): unknown;
  on(event: 'close' | 'error' | 'pong', listener: () => void): unknown;
  once(event: 'close', listener: () => void): unknown;
}

export interface AgentConn {
  serverId: string;
  ws: AgentSocket;
  /** Операции агента из hello; у старых агентов списка нет. */
  methods: readonly string[];
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onStream?: (channel: string, chunk: string) => void;
  timer: NodeJS.Timeout;
}

export interface RegistryEvents {
  online: [serverId: string];
  offline: [serverId: string];
  metrics: [serverId: string, metrics: Metrics];
  inventory: [serverId: string, inventory: Inventory];
  heartbeat: [serverId: string];
  /** Сообщение агента не прошло схему (null вместо массива, новое значение) - оно отброшено. */
  invalid: [serverId: string, error: string];
}

/**
 * Реестр живых соединений с агентами. Один агент - одно соединение;
 * запросы к агенту получают id, ответ матчится по id, стрим летит в колбэк.
 */
export class AgentRegistry extends EventEmitter<RegistryEvents> {
  private conns = new Map<string, AgentConn>();
  private pending = new Map<string, Pending>();
  /** Серверы, где агент обновляется и перезапускается: пока не вернётся (или 3 минуты). */
  private updating = new Map<string, number>();
  /** Последние метрики агента и их время: в базу они пишутся реже, чем приходят. */
  private metrics = new Map<string, { metrics: Metrics; at: string }>();

  latestMetrics(serverId: string): { metrics: Metrics; at: string } | undefined {
    return this.metrics.get(serverId);
  }

  markUpdating(serverId: string) {
    this.updating.set(serverId, Date.now());
  }

  isUpdating(serverId: string): boolean {
    const at = this.updating.get(serverId);
    if (at === undefined) return false;
    if (Date.now() - at > 3 * 60_000) {
      this.updating.delete(serverId);
      return false;
    }
    return true;
  }

  /** Запрашивает свежий снимок у агента и раздаёт его как обычный inventory. Ошибки глотает. */
  async refreshInventory(serverId: string): Promise<void> {
    if (!this.isOnline(serverId)) return;
    try {
      const raw = await this.request(serverId, 'inventory.get', {}, { timeoutMs: 120_000 });
      this.emit('inventory', serverId, InventorySchema.parse(raw));
    } catch {
      // агент отвалился или прислал мусор - следующий снимок придёт по расписанию
    }
  }

  isOnline(serverId: string): boolean {
    return this.conns.has(serverId);
  }

  get(serverId: string): AgentConn | undefined {
    return this.conns.get(serverId);
  }

  onlineIds(): string[] {
    return [...this.conns.keys()];
  }

  /** Агент на связи и знает операцию (по списку из hello). */
  supports(serverId: string, method: AgentMethod): boolean {
    return Boolean(this.conns.get(serverId)?.methods.includes(method));
  }

  attach(conn: AgentConn) {
    const old = this.conns.get(conn.serverId);
    if (old && old.ws !== conn.ws) old.ws.close(4000, 'replaced by new connection');
    this.conns.set(conn.serverId, conn);
    conn.ws.on('message', (raw) => this.handle(conn, raw.toString()));
    conn.ws.on('close', () => this.detach(conn));
    conn.ws.on('error', () => this.detach(conn));
    // Пинг раз в 30 с; если агент молчит 90 с (ни pong, ни сообщений) - соединение мёртвое.
    let alive = Date.now();
    conn.ws.on('pong', () => {
      alive = Date.now();
    });
    conn.ws.on('message', () => {
      alive = Date.now();
    });
    const ping = setInterval(() => {
      if (Date.now() - alive > 90_000) {
        conn.ws.terminate();
        return;
      }
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }, 30_000);
    conn.ws.once('close', () => clearInterval(ping));
    this.updating.delete(conn.serverId);
    this.emit('online', conn.serverId);
  }

  private detach(conn: AgentConn) {
    if (this.conns.get(conn.serverId)?.ws !== conn.ws) return;
    this.conns.delete(conn.serverId);
    for (const [id, p] of this.pending) {
      if (id.startsWith(`${conn.serverId}:`)) {
        clearTimeout(p.timer);
        p.reject(agentError('Агент отключился', 502));
        this.pending.delete(id);
      }
    }
    this.emit('offline', conn.serverId);
  }

  private handle(conn: AgentConn, raw: string) {
    let msg: AgentMessage;
    try {
      msg = AgentMessageSchema.parse(JSON.parse(raw));
    } catch (e) {
      const issues = (e as { issues?: { path: (string | number)[]; message: string }[] }).issues;
      this.emit(
        'invalid',
        conn.serverId,
        issues
          ? issues
              .slice(0, 3)
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; ')
          : (e as Error).message,
      );
      return;
    }
    switch (msg.type) {
      case 'heartbeat':
        this.emit('heartbeat', conn.serverId);
        return;
      case 'metrics':
        this.metrics.set(conn.serverId, { metrics: msg.metrics, at: new Date().toISOString() });
        this.emit('metrics', conn.serverId, msg.metrics);
        return;
      case 'inventory':
        this.emit('inventory', conn.serverId, msg.inventory);
        return;
      case 'stream': {
        this.pending.get(`${conn.serverId}:${msg.id}`)?.onStream?.(msg.channel, msg.chunk);
        return;
      }
      case 'result': {
        const key = `${conn.serverId}:${msg.id}`;
        const p = this.pending.get(key);
        if (!p) return;
        this.pending.delete(key);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.data);
        else if (msg.error?.startsWith('метод пока не поддерживается'))
          p.reject(agentError(AGENT_OUTDATED, 409));
        else p.reject(agentError(msg.error ?? 'Ошибка агента', 502));
        return;
      }
      case 'hello':
        return;
    }
  }

  /** Вызов метода агента. Стрим (stdout/stderr) приходит в onStream по мере выполнения. */
  request<T = unknown>(
    serverId: string,
    method: AgentMethod,
    params: Record<string, unknown> = {},
    opts: { timeoutMs?: number; onStream?: (channel: string, chunk: string) => void } = {},
  ): Promise<T> {
    const conn = this.conns.get(serverId);
    if (!conn) return Promise.reject(agentError('Агент не подключён', 409));
    if (!this.supports(serverId, method)) return Promise.reject(agentError(AGENT_OUTDATED, 409));
    const id = newId();
    const key = `${serverId}:${id}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(agentError('Агент не ответил вовремя', 504));
      }, opts.timeoutMs ?? 60_000);
      const entry: Pending = { resolve: (v) => resolve(v as T), reject, timer };
      if (opts.onStream) entry.onStream = opts.onStream;
      this.pending.set(key, entry);
      const msg: PanelMessage = { type: 'request', id, method, params };
      conn.ws.send(JSON.stringify(msg), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(key);
          reject(err);
        }
      });
    });
  }
}
