import { parseCb } from './codec.js';
import type { Core } from './core.js';
import { type ChatId, type TgMessage, notModified } from './transport.js';
import { type Btn, I, type Screen } from './views/common.js';

/**
 * Одно сообщение на дело: подтверждение, ход и итог действия, переходы из уведомления - на
 * месте нажатого сообщения. Здесь - что было в сообщении до этого (origin: "Отмена" и "К
 * уведомлению" возвращают его) и каким нажатием открыт экран в сообщении (screen: "Назад" и
 * повтор). Хранится в BotStore: после перезапуска панели кнопки возврата работают.
 */

/** Как сообщение выглядело до действия: текст с разметкой и кнопки. */
interface Origin {
  text: string;
  entities: unknown[];
  kb: { inline_keyboard?: { callback_data?: string }[][] };
  /** уведомление панели, а не экран бота */
  notify: boolean;
}

/** Сообщения старше двух недель бот уже не правит. */
const KEEP_MS = 14 * 24 * 3600_000;

const ORIGIN = 'origin';
const SCREEN = 'screen';

export class Messages {
  constructor(private core: Pick<Core, 'tg' | 'store' | 'screen'>) {}

  private key(chat: ChatId, mid: number) {
    return `${chat}:${mid}`;
  }

  /** Запомнить вид сообщения до действия (если ещё не запомнен). */
  stash(msg: TgMessage) {
    const k = this.key(msg.chat.id, msg.message_id);
    const { store } = this.core;
    if (store.has(ORIGIN, k)) return;
    const o: Origin = {
      text: msg.text ?? '',
      entities: msg.entities ?? [],
      kb: msg.reply_markup ?? { inline_keyboard: [] },
      notify: !store.has(SCREEN, k),
    };
    store.put(ORIGIN, k, o, KEEP_MS);
  }

  hasOrigin(chat: ChatId, mid: number): boolean {
    return this.core.store.has(ORIGIN, this.key(chat, mid));
  }

  /**
   * Действие на экране закончилось: прежний вид экрана больше не нужен. У уведомления он
   * остаётся - для "К уведомлению".
   */
  release(chat: ChatId, mid: number) {
    const k = this.key(chat, mid);
    if (this.core.store.get<Origin>(ORIGIN, k)?.notify === false) this.core.store.delete(ORIGIN, k);
  }

  dropOrigin(chat: ChatId, mid: number) {
    this.core.store.delete(ORIGIN, this.key(chat, mid));
  }

  /** Вернуть сообщению прежний вид; drop - без кнопки с этими данными. */
  async restore(chat: ChatId, mid: number, drop?: string): Promise<boolean> {
    const k = this.key(chat, mid);
    const o = this.core.store.get<Origin>(ORIGIN, k);
    if (!o) return false;
    this.core.store.delete(ORIGIN, k);
    const rows = (o.kb.inline_keyboard ?? [])
      .map((r) => r.filter((b) => !drop || b.callback_data !== drop))
      .filter((r) => r.length);
    await this.core.tg.send('editMessageText', {
      chat_id: chat,
      message_id: mid,
      text: o.text,
      entities: o.entities,
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: rows },
    });
    return true;
  }

  /** Экран в сообщении открыт нажатием data. */
  rememberScreen(chat: ChatId, mid: number, data: string) {
    this.core.store.put(SCREEN, this.key(chat, mid), data, KEEP_MS);
  }

  forgetScreen(chat: ChatId, mid: number) {
    this.core.store.delete(SCREEN, this.key(chat, mid));
  }

  screenOf(chat: ChatId, mid: number): string | null {
    return this.core.store.get<string>(SCREEN, this.key(chat, mid));
  }

  /** Кнопки возврата под итогом: к экрану, с которого начали, и к уведомлению. */
  backRows(chat: ChatId, mid: number): Btn[][] {
    const rows: Btn[][] = [];
    const scr = this.screenOf(chat, mid);
    if (scr) rows.push([{ text: `${I.back} Назад`, data: scr }]);
    if (this.core.store.get<Origin>(ORIGIN, this.key(chat, mid))?.notify)
      rows.push([{ text: `${I.back} К уведомлению`, data: 'ob' }]);
    return rows;
  }

  /** Экран на месте сообщения; если оно было уведомлением - с кнопкой возврата к нему. */
  paint(chat: ChatId, mid: number, s: Screen) {
    const notify = this.core.store.get<Origin>(ORIGIN, this.key(chat, mid))?.notify;
    const kb = notify ? [...s.kb, [{ text: `${I.back} К уведомлению`, data: 'ob' }]] : s.kb;
    return this.core.tg.editText(chat, mid, s.text, { text: s.text, kb });
  }

  /** Открыть экран заново на месте сообщения (и запомнить его); false - экрана нет. */
  async reopen(chat: ChatId, mid: number, op: string, args: string[]): Promise<boolean> {
    const s = await this.core.screen(op, args).catch(() => null);
    if (!s) return false;
    this.rememberScreen(chat, mid, [op, ...args].join(':'));
    await this.paint(chat, mid, s);
    return true;
  }

  /** "Отмена": экран - открыть заново, уведомление - вернуть как было, иначе удалить. */
  async cancelIn(chat: ChatId, mid: number) {
    const scr = this.screenOf(chat, mid);
    if (scr) {
      const { op, args } = parseCb(scr);
      const s = await this.core.screen(op, args).catch(() => null);
      if (s) {
        await this.paint(chat, mid, s);
        this.release(chat, mid);
        return;
      }
    }
    if (!(await this.restore(chat, mid))) await this.core.tg.remove(chat, mid);
  }

  /**
   * Успешный итог на месте сообщения. Уведомление становится итогом (возврат к нему не нужен),
   * экран - итогом с кнопкой "Назад".
   */
  async settle(chat: ChatId, mid: number, text: string, kb: Btn[][]) {
    const onScreen = this.screenOf(chat, mid) !== null;
    const rows = [...kb, ...(onScreen ? this.backRows(chat, mid) : [])];
    this.dropOrigin(chat, mid);
    await this.core.tg.editText(chat, mid, text, { text, kb: rows });
  }

  /** Итог с ошибкой на месте сообщения: с кнопками возврата. */
  fail(chat: ChatId, mid: number, text: string, kb: Btn[][] = []) {
    return this.core.tg.editText(chat, mid, text, {
      text,
      kb: [...kb, ...this.backRows(chat, mid)],
    });
  }

  /** Экран на месте нажатого сообщения; править нельзя (удалено, слишком старое) - новым. */
  async edit(msg: TgMessage, s: Screen) {
    const r = await this.paint(msg.chat.id, msg.message_id, s);
    if (!r.ok && !notModified(r) && r.status === 400) await this.core.tg.reply(msg.chat.id, s);
  }
}
