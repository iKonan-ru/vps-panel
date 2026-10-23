/** Управление панелью через Telegram-бота: состояние для настроек. */

/** Привязанный администратор: аккаунт Telegram, которому бот отвечает. */
export interface BotAdmin {
  /** user id в Telegram */
  id: string;
  name: string;
  username: string;
  /** когда привязан, ISO */
  at: string;
}

/** Приём сообщений ботом (long polling). */
export interface BotPoll {
  /** null - ещё не опрашивали */
  ok: boolean | null;
  /** последний ответ Telegram, ISO */
  lastOkAt: string | null;
  /** путь: direct, env, proxy:<id сервера> */
  via: string | null;
  error: string | null;
}

/** GET /api/notify/bot */
export interface BotView {
  on: boolean;
  admin: BotAdmin | null;
  poll: BotPoll;
  /** имя бота (без @), если известно */
  username: string | null;
  /** что можно из бота: только просмотр, безопасные действия, все (опасные - с кодом 2FA) */
  level: BotLevel;
}

export type BotLevel = 'view' | 'safe' | 'all';

/** POST /api/notify/bot/link: ссылка привязки, одноразовая. */
export interface BotLink {
  url: string;
  expiresAt: string;
}
