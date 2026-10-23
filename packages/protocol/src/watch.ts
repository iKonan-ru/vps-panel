import type { GService } from './clients.js';

/**
 * Уведомления о подключении клиентов: правило следит за связью клиента с сервисом на сервере.
 * Сервер, сервис и устройство можно не задавать ("любой"): клиент на связи, если на связи хотя бы
 * одна подходящая привязка.
 */

/** О чём сообщать: отключение, подключение после отключения или оба. */
export type WatchEvent = 'down' | 'up' | 'both';
export const WATCH_EVENTS: readonly { id: WatchEvent; title: string }[] = [
  { id: 'down', title: 'Отключение' },
  { id: 'up', title: 'Подключение' },
  { id: 'both', title: 'Отключение и подключение' },
];

/** Сервисы, у которых панель видит подключение клиента (OpenFlux видит не все каналы). */
export const WATCH_SERVICES: readonly GService[] = ['awg', 'xui', 'mtproxyl', 'wdtt', 'naive'];

/** Через сколько минут без связи клиент считается отключённым. */
export const WATCH_DELAY_LIMITS: [number, number] = [1, 1440];
export const WATCH_DELAY_DEFAULT = 5;
/** Правил всего, не больше. */
export const WATCH_MAX = 200;

/**
 * Состояние правила по последней проверке: up - на связи, down - не на связи, unknown - не
 * узнать (сервер не в сети, сервис не отвечает, привязок нет), pending - ещё не проверялось,
 * off - правило выключено.
 */
export type WatchStatus = 'up' | 'down' | 'unknown' | 'pending' | 'off';

/** Тело создания и правки правила. */
export interface WatchRuleBody {
  clientId: string;
  /** null - любой */
  serverId: string | null;
  service: GService | null;
  deviceId: string | null;
  event: WatchEvent;
  delayMinutes: number;
  enabled: boolean;
}

export interface WatchRuleView extends WatchRuleBody {
  id: string;
  clientName: string;
  /** null - любой; сервер или устройство удалены - пустая строка */
  serverName: string | null;
  deviceName: string | null;
  status: WatchStatus;
  /** отключён дольше задержки: о нём уже сообщено (или сообщено было бы) */
  offline: boolean;
  /** последняя активность клиента, ISO; null - неизвестна */
  lastSeen: string | null;
  /** с какого момента не на связи по наблюдению панели, ISO */
  downSince: string | null;
  /** время последней проверки, ISO */
  checkedAt: string | null;
  /** почему unknown */
  note: string;
}

/** Что можно выбрать в правиле: клиенты, их устройства и привязки (сервер x сервис). */
export interface WatchClientOption {
  id: string;
  name: string;
  devices: { id: string; name: string }[];
  targets: { serverId: string; serverName: string; service: GService; deviceId: string | null }[];
}

/** GET /api/watch */
export interface WatchList {
  rules: WatchRuleView[];
  clients: WatchClientOption[];
}
