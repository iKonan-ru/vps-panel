import type { TgApiResult } from '../lib/telegram.js';
import type { BotTelegram } from './core.js';
import type { Screen } from './views/common.js';

/** Типы Bot API: только то, что читает бот. */
export interface TgUser {
  id: number;
  is_bot?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}
export interface TgChat {
  id: number;
  type: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}
export interface TgMessage {
  message_id: number;
  date: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  entities?: unknown[];
  reply_markup?: { inline_keyboard?: { text: string; callback_data?: string; url?: string }[][] };
}
export interface TgCallback {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}
export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallback;
  my_chat_member?: { chat: TgChat; from: TgUser; date: number };
}

export type ChatId = number | string;

/** Ответ на нажатие кнопки: всплывающий текст (alert - окном с кнопкой) или ничего. */
export type Answer = (text?: string, alert?: boolean) => Promise<TgApiResult>;

/** Пауза между вызовами отправки: у Telegram лимит на частоту в чате. */
const SEND_GAP_MS = 300;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Ответ Telegram, который ошибкой не считаем: экран не изменился. */
export const notModified = (r: TgApiResult) =>
  !r.ok && /message is not modified/i.test(r.description ?? '');

/** Кнопки экрана в разметке Telegram: ссылка, копирование текста или нажатие. */
export function markup(s: Screen) {
  return {
    inline_keyboard: s.kb.map((row) =>
      row.map((b) =>
        b.url
          ? { text: b.text, url: b.url }
          : b.copy
            ? { text: b.text, copy_text: { text: b.copy } }
            : { text: b.text, callback_data: b.data ?? 'noop' },
      ),
    ),
  };
}

/** Отправка в Telegram: вызовы по очереди, с паузой; 429 - ждём, сколько сказал Telegram. */
export class Sender {
  private chain: Promise<unknown> = Promise.resolve();
  private lastSendAt = 0;

  constructor(
    private api: BotTelegram['api'],
    private log: { warn: (o: unknown, m?: string) => void },
  ) {}

  send(method: string, params: Record<string, unknown>): Promise<TgApiResult> {
    const run = async () => {
      const wait = this.lastSendAt + SEND_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      let r = await this.api(method, params);
      if (!r.ok && r.status === 429 && r.retryAfter && r.retryAfter <= 60) {
        await sleep(r.retryAfter * 1000);
        r = await this.api(method, params);
      }
      this.lastSendAt = Date.now();
      if (!r.ok && !notModified(r))
        this.log.warn({ method, err: r.description ?? r.error }, 'бот: вызов Telegram');
      return r;
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => undefined);
    return p;
  }

  /** Экран новым сообщением (replyTo - ответом на сообщение). */
  reply(chat: ChatId, s: Screen, replyTo?: number) {
    return this.send('sendMessage', {
      chat_id: chat,
      text: s.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: markup(s),
      ...(replyTo
        ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } }
        : {}),
    });
  }

  /** Текст сообщения заново; кнопки - экрана s, без него кнопок нет. */
  editText(chat: ChatId, mid: number, text: string, s?: Screen) {
    return this.send('editMessageText', {
      chat_id: chat,
      message_id: mid,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: s ? markup(s) : { inline_keyboard: [] },
    });
  }

  /** Экран на месте сообщения: текст и кнопки. */
  show(chat: ChatId, mid: number, s: Screen) {
    return this.editText(chat, mid, s.text, s);
  }

  remove(chat: ChatId, mid: number) {
    return this.send('deleteMessage', { chat_id: chat, message_id: mid });
  }
}

/** id отправленного сообщения из ответа sendMessage. */
export const sentId = (r: TgApiResult | null): number | undefined =>
  r?.ok ? (r.result as { message_id?: number }).message_id : undefined;
