import {
  type ActionListRow,
  type BotAdmin,
  type GClientRow,
  type ServerReach,
  type ServerSummary,
  type ServiceUpdate,
  type TgHealthView,
  actionTitle,
} from '@vps/protocol';
import { daysToPayment } from '../../lib/billing.js';
import { esc, tgWhen } from '../../lib/telegram.js';
import { cb } from '../codec.js';
import {
  type Btn,
  type Ctx,
  DASH,
  I,
  SEP,
  type Screen,
  cut,
  grid,
  panelLink,
  plural,
  q,
} from './common.js';
import { money, paymentWhen, problems, serverIcon } from './servers.js';

/** Меню, сводка, поиск и управление ботом. */

/** Кнопки постоянного меню: их текст приходит сообщением. */
export const MENU = {
  summary: 'Сводка',
  servers: 'Серверы',
  clients: 'Клиенты',
  log: 'Журнал',
  more: 'Ещё',
};
export const MENU_KEYBOARD = {
  keyboard: [
    [{ text: MENU.summary }, { text: MENU.servers }],
    [{ text: MENU.clients }, { text: MENU.log }, { text: MENU.more }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};

/** Команды бота в меню слева от поля ввода (только в чате администратора). */
export const COMMANDS = [
  { command: 'menu', description: 'Сводка' },
  { command: 'servers', description: 'Серверы' },
  { command: 'clients', description: 'Клиенты' },
  { command: 'log', description: 'Журнал действий' },
  { command: 'settings', description: 'Управление через бота' },
];

// ---- сводка ----

export interface SummaryData {
  version: string;
  /** новая версия панели в её канале */
  newer: string | null;
  servers: ServerSummary[];
  reach: Record<string, ServerReach>;
  updates: Record<string, ServiceUpdate[]>;
  clients: GClientRow[];
  running: ActionListRow[];
}

export function summaryView(d: SummaryData, c: Ctx): Screen {
  const lines: string[] = [
    `<b>VPS Panel ${esc(d.version)}</b>${d.newer ? `${SEP}доступна ${esc(d.newer)}` : ''}`,
    '',
  ];
  const by = (st: ServerSummary['status']) => d.servers.filter((s) => s.status === st).length;
  const online = by('online');
  const offline = by('offline');
  const counts = [`${online} в сети`];
  if (offline) counts.push(`${offline} не в сети`);
  if (by('rebooting')) counts.push(`${by('rebooting')} перезагружается`);
  if (by('no-agent')) counts.push(`${by('no-agent')} без агента`);
  lines.push(d.servers.length ? `<b>Серверы:</b> ${counts.join(', ')}` : '<b>Серверов нет</b>');

  // не в сети - первыми, остальное - по имени (как в списке серверов)
  const troubled = d.servers
    .map((s) => ({ s, list: problems(s, d.reach[s.id], c.now) }))
    .filter((x) => x.list.length > 0)
    .map((x) => ({ ...x, icon: serverIcon(x.s, x.list) }))
    .sort((a, b) => Number(b.s.status === 'offline') - Number(a.s.status === 'offline'));
  for (const { s, list, icon } of troubled.slice(0, 8)) {
    const more = list.length > 1 ? ` (+${list.length - 1})` : '';
    lines.push(`${icon} ${esc(s.name)}${DASH}${esc(list[0]?.text ?? '')}${more}`);
  }
  if (troubled.length > 8) lines.push(`и ещё ${troubled.length - 8}`);
  if (d.servers.length && !troubled.length) lines.push('Проблем нет');

  // обновления: сервисы по названию, пакеты безопасности, агенты
  const upd = new Map<string, number>();
  const add = (k: string) => upd.set(k, (upd.get(k) ?? 0) + 1);
  for (const s of d.servers) {
    for (const u of d.updates[s.id] ?? []) add(u.title);
    if ((s.audit?.pendingUpdates ?? 0) > 0) add('пакеты безопасности');
    if (s.agentUpdateAvailable && !s.agentUpdating) add('агент');
  }
  if (upd.size)
    lines.push(
      `Обновления: ${[...upd]
        .map(([k, n]) => `${esc(k)} на ${n} ${plural(n, 'сервере', 'серверах', 'серверах')}`)
        .join(', ')}`,
    );
  const pays = d.servers
    .filter((s) => s.hosting.nextPaymentAt)
    .map((s) => ({ s, days: daysToPayment(s.hosting.nextPaymentAt ?? '', c.now) }))
    .filter((x) => x.days >= 0 && x.days <= 3)
    .sort((a, b) => a.days - b.days);
  for (const { s, days } of pays) {
    const price = money(s.hosting.price, s.hosting.currency);
    lines.push(`Оплата: ${esc(s.name)} ${paymentWhen(days)}${price ? `, ${price}` : ''}`);
  }

  if (d.clients.length) {
    const errors = d.clients.filter((x) => x.states.error > 0).length;
    lines.push(
      '',
      `<b>Клиенты:</b> ${d.clients.length}${errors ? `, ошибки синхронизации${DASH}${errors}` : ''}`,
    );
  }
  if (d.running.length) {
    const names = new Map(d.servers.map((s) => [s.id, s.name]));
    const list = d.running.slice(0, 3).map((a) => {
      const sv = a.serverId ? names.get(a.serverId) : null;
      return `${esc(actionTitle(a.kind, a.params))}${sv ? ` (${esc(sv)})` : ''}`;
    });
    lines.push(`<b>Сейчас:</b> ${list.join('; ')}${d.running.length > 3 ? ' \u2026' : ''}`);
  }

  const kb: Btn[][] = [];
  const shown = troubled.slice(0, 6);
  kb.push(
    ...grid(
      shown.map(({ s, icon }) => ({ text: `${icon} ${cut(s.name, 18)}`, data: cb('sv', s.id) })),
      3,
    ),
  );
  kb.push([
    { text: 'Серверы', data: cb('sl', '-', 0) },
    { text: 'Клиенты', data: cb('gl', 0, 0) },
  ]);
  kb.push([
    { text: 'Журнал', data: cb('lg', '-', 0) },
    { text: 'Обновить', data: cb('m') },
  ]);
  return { text: lines.join('\n'), kb };
}

// ---- управление ботом ----

export function settingsView(
  d: { admin: BotAdmin | null; version: string; newer: string | null; health: TgHealthView },
  c: Ctx,
): Screen {
  const lines = ['<b>Управление через бота</b>', ''];
  if (d.admin)
    lines.push(
      `Аккаунт: ${esc(d.admin.name)}${d.admin.username ? ` (@${esc(d.admin.username)})` : ''}`,
    );
  lines.push(`Версия панели: ${esc(d.version)}${d.newer ? `, доступна ${esc(d.newer)}` : ''}`);
  const h = d.health;
  lines.push(
    h.ok === false
      ? `Уведомления: ${I.bad} не доходят${h.failingSince ? ` с ${tgWhen(h.failingSince, c.now)}` : ''}${h.pending ? `, отложено ${h.pending}` : ''}`
      : `Уведомления: ${I.ok} доходят`,
  );
  const kb: Btn[][] = [
    [
      { text: 'Версия панели', data: cb('vs') },
      { text: 'Резервная копия', data: cb('pb') },
    ],
    [
      { text: 'Уведомления', data: cb('ns') },
      { text: 'Синхронизация', data: cb('sy') },
    ],
    [
      { text: 'Маршрут до Telegram', data: cb('tr') },
      { text: 'Сессии', data: cb('ss') },
    ],
    [{ text: 'Отключить управление', data: cb('off') }],
  ];
  const link = panelLink(c, '/settings');
  if (link.length) kb.push([{ text: 'Настройки панели', url: link[0]?.url ?? '' }]);
  return { text: lines.join('\n'), kb };
}

export function offConfirmView(): Screen {
  return {
    text: `Отключить управление через бота?\nВключить снова: ${q('Настройки')}${DASH}${q('Уведомления в Telegram')}. Уведомления продолжат приходить.`,
    kb: [
      [
        { text: 'Отключить', data: cb('off!') },
        { text: 'Отмена', data: cb('st') },
      ],
    ],
  };
}

export const OFF_TEXT = `Управление через бота отключено. Включить снова: ${q('Настройки')}${DASH}${q('Уведомления в Telegram')}.`;

// ---- поиск ----

export function searchView(
  query: string,
  found: ServerSummary[],
  clients: { id: string; name: string }[] = [],
): Screen {
  if (!found.length && !clients.length)
    return { text: `Ничего не найдено по запросу ${q(esc(cut(query, 60)))}`, kb: [] };
  const kb: Btn[][] = [];
  const all: Btn[] = [
    ...found.slice(0, 12).map((s) => ({ text: cut(s.name, 24), data: cb('sv', s.id) })),
    ...clients
      .slice(0, 12)
      .map((c) => ({ text: `${I.user} ${cut(c.name, 22)}`, data: cb('gc', c.id) })),
  ];
  kb.push(...grid(all, 2));
  const parts = [];
  if (found.length) parts.push(`серверов: ${found.length}`);
  if (clients.length) parts.push(`клиентов: ${clients.length}`);
  return { text: `Найдено ${parts.join(', ')}`, kb };
}

/** Поиск сервера по имени или адресу, без учёта регистра. */
export function findServers(list: ServerSummary[], query: string): ServerSummary[] {
  const qq = query.trim().toLocaleLowerCase('ru');
  if (!qq) return [];
  const exact = list.filter((s) => s.name.toLocaleLowerCase('ru') === qq);
  if (exact.length) return exact;
  return list.filter(
    (s) =>
      s.name.toLocaleLowerCase('ru').includes(qq) || s.host.toLocaleLowerCase('ru').includes(qq),
  );
}

export const STALE_TEXT = 'Кнопка устарела, экран открыт заново';

export function welcomeText(name: string): string {
  return `Аккаунт ${esc(name)} привязан к VPS Panel. Меню${DASH}кнопками внизу, поиск сервера${DASH}его имя сообщением.`;
}
