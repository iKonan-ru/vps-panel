import type { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import type { AgentRegistry } from '../agents/registry.js';
import { newId } from './ids.js';

/** Поток живёт, пока его держит прокси (keep-alive браузера), но не больше 12 часов. */
const OPEN_TIMEOUT_MS = 12 * 3600_000;

/**
 * Поток к 127.0.0.1:<порт> на сервере через websocket агента (операции tunnel.*): панели сервисов слушают только loopback и снаружи недоступны совсем. Для http-proxy
 * и http.Agent выглядит как сокет. Пока агент не ответил "open", записи копятся по порядку;
 * дальше уходят по порядку (агент выполняет tunnel.write в порядке прихода).
 *
 * Поток никогда не выбрасывает 'error': TLS поверх потока дописывает close_notify в уже
 * закрытый поток (3X-UI перезапустили при открытой панели), и ошибка на сокете без обработчика
 * уронила бы всю панель. Закрытие с той стороны - конец чтения,
 * запись после него молча отбрасывается, сбой агента - просто destroy(): запрос прокси увидит
 * обрыв соединения своим обработчиком.
 */
export class TunnelSocket extends Duplex {
  readonly id = `t${newId()}`;
  private opened = false;
  private remoteClosed = false;
  private queue: { data: string; cb: (e?: Error | null) => void }[] = [];

  constructor(
    private registry: AgentRegistry,
    private serverId: string,
    port: number,
  ) {
    // allowHalfOpen: конец чтения не закрывает запись сам - TLS дописывает close_notify в
    // _write, а не в уже закрытый поток
    super({ allowHalfOpen: true });
    registry
      .request(
        serverId,
        'tunnel.open',
        { id: this.id, port },
        {
          timeoutMs: OPEN_TIMEOUT_MS,
          onStream: (channel, chunk) => {
            if (channel === 'data') this.push(Buffer.from(chunk, 'base64'));
            else if (channel === 'log' && chunk === 'open') this.onOpen();
          },
        },
      )
      .then(() => {
        this.remoteClosed = true;
        this.push(null);
      })
      .catch(() => {
        this.remoteClosed = true;
        this.destroy();
      });
  }

  private onOpen() {
    this.opened = true;
    const queued = this.queue;
    this.queue = [];
    for (const w of queued) this.send(w.data, w.cb);
  }

  private send(data: string, cb: (e?: Error | null) => void) {
    // поток на сервере уже закрыт: писать некуда, это не ошибка
    if (this.remoteClosed) return cb();
    // не ждём ответа на каждый кусок: порядок держит агент, сбой рвёт поток
    this.registry
      .request(this.serverId, 'tunnel.write', { id: this.id, data }, { timeoutMs: 30_000 })
      .catch(() => this.destroy());
    cb();
  }

  override _read() {}

  override _write(chunk: Buffer, _enc: BufferEncoding, cb: (e?: Error | null) => void) {
    const data = chunk.toString('base64');
    if (this.opened) this.send(data, cb);
    else this.queue.push({ data, cb });
  }

  override _final(cb: (e?: Error | null) => void) {
    this.closeRemote();
    cb();
  }

  override _destroy(_err: Error | null, cb: (e?: Error | null) => void) {
    this.closeRemote();
    for (const w of this.queue) w.cb();
    this.queue = [];
    cb(null);
  }

  private closeRemote() {
    if (this.remoteClosed) return;
    this.remoteClosed = true;
    this.registry
      .request(this.serverId, 'tunnel.close', { id: this.id }, { timeoutMs: 10_000 })
      .catch(() => undefined);
  }

  // http.Agent и ClientRequest зовут методы net.Socket: у потока через агента им нечего делать
  setKeepAlive() {
    return this;
  }
  setNoDelay() {
    return this;
  }
  setTimeout(_ms: number, cb?: () => void) {
    if (cb) this.once('timeout', cb);
    return this;
  }
  ref() {
    return this;
  }
  unref() {
    return this;
  }
}

/**
 * Соединение для http.Agent / https.Agent (createConnection): поток через агента, для https -
 * TLS поверх него. Сертификаты панелей сервисов самоподписанные или на IP - проверять нечего:
 * поток и так идёт в шифрованном канале агента до 127.0.0.1 сервера.
 */
export function tunnelConnection(
  registry: AgentRegistry,
  serverId: string,
  port: number,
  tls: boolean,
): Socket {
  const raw = new TunnelSocket(registry, serverId, port);
  // запасной обработчик: ошибка сокета без слушателя роняла бы весь процесс (агенты, панель);
  // запрос прокси узнаёт об обрыве своим обработчиком 'error'
  raw.on('error', () => undefined);
  if (!tls) return raw as unknown as Socket;
  const s = tlsConnect({ socket: raw, rejectUnauthorized: false });
  s.on('error', () => raw.destroy());
  s.on('close', () => raw.destroy());
  return s;
}
