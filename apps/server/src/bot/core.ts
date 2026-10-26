import type { BotLevel } from '@vps/protocol';
import type { Db } from '../db/index.js';
import type { Telegram } from '../lib/telegram.js';
import type { UiEvent } from '../lib/ui-hub.js';
import type { Risk } from './actions.js';
import type { Refs } from './codec.js';
import type { Messages } from './messages.js';
import type { Inject, PanelApi } from './panel-api.js';
import type { BotStore } from './store.js';
import type { Sender } from './transport.js';
import type { Ctx, Screen } from './views/common.js';

export type BotTelegram = Pick<
  Telegram,
  'api' | 'settings' | 'health' | 'muteUntil' | 'sendDocument' | 'sendFile'
> & {
  chatsFromBot: Telegram['chatsFromBot'];
  buttons: Telegram['buttons'];
};

export interface BotDeps {
  db: Db;
  telegram: BotTelegram;
  /** запрос к API панели (app.inject): бот видит то же, что интерфейс */
  inject: Inject;
  panelUrl: string;
  version: string;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  /** события действий: ход запущенного из бота */
  hub?: { listen: (fn: (ev: UiEvent) => void) => () => void };
}

/** Общее для частей бота: отправка, API панели, ссылки, состояние сообщений, экраны. */
export interface Core {
  deps: BotDeps;
  tg: Sender;
  api: PanelApi;
  refs: Refs;
  store: BotStore;
  msgs: Messages;
  level(): BotLevel;
  ctx(): Ctx;
  /** экран по операции кнопки; null - кнопка устарела */
  screen(op: string, args: string[]): Promise<Screen | null>;
}

/** Действие этого риска на уровне доступа бота нельзя: причина; можно - null. */
export function refusal(level: BotLevel, risk: Risk): string | null {
  if (level === 'view')
    return 'Действия выключены: в настройках бота уровень \u00abтолько просмотр\u00bb';
  if (level === 'safe' && risk !== 'safe')
    return 'Это действие выключено: в настройках бота уровень \u00abбезопасные действия\u00bb';
  return null;
}
