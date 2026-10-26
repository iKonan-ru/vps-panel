import type { BotLevel } from '@vps/protocol';
import { cb } from './codec.js';
import type { Btn } from './views/common.js';

export type { BotLevel };

/** Сервисы, которые бот перезапускает: вид в снимке агента - код операции. */
export const RESTART: Record<string, { code: string; title: string }> = {
  xui: { code: 'x', title: '3X-UI' },
  mtproxyl: { code: 'm', title: 'MTProxyL' },
};

/** Обновления сервисов: вид из проверки обновлений - код операции. */
export const UPDATE: Record<string, { code: string; title: string }> = {
  xui: { code: 'x', title: '3X-UI' },
  xray: { code: 'y', title: 'Xray' },
  mtproxyl: { code: 'm', title: 'MTProxyL' },
  'mtproxyl-panel': { code: 'p', title: 'веб-панель MTProxyL' },
};

export interface NotifyInfo {
  event: string;
  serverId?: string | undefined;
  data?: Record<string, string> | undefined;
  /** панель хостера сервера (https) для кнопки-ссылки */
  providerUrl?: string | undefined;
}

/**
 * Кнопки к уведомлению по его событию. Переходы (op "o") открывают экран новым сообщением,
 * действия - по уровню доступа: при "только просмотр" остаются переходы и ссылки.
 * ref - короткая ссылка на значение, которое не помещается в callback_data (версия панели).
 */
export function notifyButtons(n: NotifyInfo, level: BotLevel, ref: (v: string) => string): Btn[][] {
  const sid = n.serverId ?? '';
  const act = level !== 'view';
  const server: Btn | null = sid ? { text: 'Сервер', data: cb('o', 'sv', sid) } : null;
  const host: Btn | null = n.providerUrl?.startsWith('https://')
    ? { text: 'Панель хостера', url: n.providerUrl }
    : null;
  const rows: (Btn | null)[][] = [];
  switch (n.event) {
    case 'offline':
      rows.push([server, host]);
      if (act) rows.push([{ text: 'Не уведомлять 1\u00a0ч', data: cb('mu', sid) }]);
      break;
    case 'serviceDown': {
      const r = RESTART[n.data?.kind ?? ''];
      if (act && r) rows.push([{ text: `Перезапустить ${r.title}`, data: cb('rs', sid, r.code) }]);
      rows.push([server]);
      break;
    }
    case 'reachAddr':
    case 'reachInbound':
    case 'reachMtproxy':
      rows.push([
        act ? { text: 'Проверить сейчас', data: cb('rk', sid) } : null,
        { text: 'Доступность', data: cb('o', 'rc', sid) },
      ]);
      break;
    case 'auditNew':
      rows.push([{ text: 'План исправления', data: cb('o', 'pl', sid) }, server]);
      break;
    case 'bans':
      rows.push([{ text: 'Баны', data: cb('o', 'bn', sid) }, server]);
      break;
    case 'pkgUpdates':
      rows.push([act ? { text: 'Обновить пакеты', data: cb('pu', sid) } : null, server]);
      break;
    case 'updXui':
    case 'updXray':
    case 'updMtproxyl':
    case 'updMtproxylPanel': {
      const u = UPDATE[n.data?.kind ?? ''];
      if (act && u) rows.push([{ text: `Обновить ${u.title}`, data: cb('up', sid, u.code) }]);
      rows.push([server]);
      break;
    }
    case 'payment':
      rows.push([host, server]);
      break;
    case 'backupFail':
      if (act) rows.push([{ text: 'Повторить', data: cb('bp') }]);
      break;
    case 'updPanel': {
      const v = n.data?.version;
      rows.push([
        act && v ? { text: 'Обновить панель', data: cb('pv', ref(v)) } : null,
        n.data?.url?.startsWith('https://') ? { text: 'Что нового', url: n.data.url } : null,
      ]);
      break;
    }
    case 'cascade':
      rows.push([
        act && n.data?.cid ? { text: 'Проверить каскад', data: cb('ck', n.data.cid) } : null,
        server,
      ]);
      break;
    case 'diskFull':
      rows.push([
        act ? { text: 'Очистить диск', data: cb('cl', sid) } : null,
        { text: 'Docker', data: cb('o', 'dk', sid) },
      ]);
      rows.push([server]);
      break;
    case 'cpuHigh':
      rows.push([server, { text: 'Docker', data: cb('o', 'dk', sid) }]);
      if (act) rows.push([{ text: 'Перезагрузить', data: cb('rb', sid) }]);
      break;
    case 'loginFails':
      rows.push([
        { text: 'Сессии', data: cb('o', 'ss') },
        act ? { text: 'Завершить все сессии', data: cb('sx') } : null,
      ]);
      break;
    case 'watch':
      if (act && n.data?.rule)
        rows.push([{ text: 'Выключить правило', data: cb('wo', n.data.rule) }]);
      break;
  }
  return rows.map((r) => r.filter((b): b is Btn => b !== null)).filter((r) => r.length > 0);
}
