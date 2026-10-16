/**
 * Сессии веб-терминала на панели. Сессия (bash на сервере через агента) не зависит от сокета
 * браузера: ушли со вкладки, закрыли страницу или PWA - сокет закрывается, а сессия ждёт
 * DETACH_MS и только потом закрывается на сервере. Вернулись раньше - тот же id подхватывает
 * сессию, панель повторяет последний вывод из буфера. Явное "Закрыть" закрывает сразу.
 */

/** Сколько сессия живёт без подключённого браузера. */
const DETACH_MS = 3 * 60_000;
/** Сколько последнего вывода (base64) помнить для повтора при возврате. */
export const BUFFER_CHARS = 512 * 1024;

/** Подключённый браузер: то, что нужно сессии от websocket. */
export interface TermPeer {
  send(o: unknown): void;
  close(code: number, reason: string): void;
}

interface TermSession {
  sid: string;
  serverId: string;
  login: string;
  peer: TermPeer | null;
  /** Куски вывода агента (base64) - последние BUFFER_CHARS символов. */
  chunks: string[];
  size: number;
  /** Всего вывода (base64), для записи в журнал. */
  total: number;
  timer: ReturnType<typeof setTimeout> | null;
}

export class TermSessions {
  private map = new Map<string, TermSession>();

  constructor(
    /** Закрыть сессию на сервере (term.close агенту). */
    private closeRemote: (s: TermSession) => void,
    private detachMs = DETACH_MS,
  ) {}

  get(sid: string): TermSession | undefined {
    return this.map.get(sid);
  }

  /** Сессию с этим id можно подхватить: тот же сервер и тот же вход в панель. */
  resumable(sid: string, serverId: string, login: string): TermSession | null {
    const s = this.map.get(sid);
    return s && s.serverId === serverId && s.login === login ? s : null;
  }

  create(sid: string, serverId: string, login: string, peer: TermPeer): TermSession {
    const s: TermSession = {
      sid,
      serverId,
      login,
      peer,
      chunks: [],
      size: 0,
      total: 0,
      timer: null,
    };
    this.map.set(sid, s);
    return s;
  }

  /** Подключить браузер к сессии: прежний (другая вкладка) отключается, вывод повторяется. */
  attach(s: TermSession, peer: TermPeer) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    const prev = s.peer;
    s.peer = peer;
    if (prev) prev.close(4010, 'taken over');
    for (const d of s.chunks) peer.send({ t: 'data', d });
  }

  /** Вывод агента: браузеру, если подключён, и в буфер. */
  output(s: TermSession, chunk: string) {
    s.total += chunk.length;
    s.chunks.push(chunk);
    s.size += chunk.length;
    while (s.size > BUFFER_CHARS && s.chunks.length > 1) s.size -= s.chunks.shift()?.length ?? 0;
    s.peer?.send({ t: 'data', d: chunk });
  }

  /**
   * Браузер отключился. explicit - "Закрыть": сессия закрывается сразу; иначе ждёт возврата
   * detachMs. Отключение не того браузера, что сейчас подключён (его вытеснила другая
   * вкладка), сессию не трогает.
   */
  detach(s: TermSession, peer: TermPeer, explicit: boolean) {
    if (s.peer !== peer) return;
    s.peer = null;
    if (!this.map.has(s.sid)) return;
    if (explicit) return this.close(s);
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => this.close(s), this.detachMs);
    s.timer.unref?.();
  }

  /** Закрыть сессию на сервере (оболочка завершится, term.open вернётся - и тогда end). */
  close(s: TermSession) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    this.closeRemote(s);
  }

  /** Оболочка завершилась или агент отвалился: сессии больше нет. */
  end(s: TermSession) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    this.map.delete(s.sid);
  }
}
