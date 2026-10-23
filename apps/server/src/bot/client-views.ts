import {
  DEVICES,
  type GClientDetail,
  type GClientLive,
  type GClientRow,
  type GService,
  type WatchRuleView,
  deviceLabel,
} from '@vps/protocol';
import { esc, tgWhen } from '../lib/telegram.js';
import { cb } from './codec.js';
import { type Btn, type Ctx, DASH, I, NB, SEP, type Screen, ago, plural, q } from './views.js';

/** Экраны клиентов панели в боте. Ссылки клиента - под спойлером, сообщение потом удаляется. */

export const SERVICE_TITLE: Record<GService, string> = {
  xui: 'VLESS',
  mtproxyl: 'MTProxy',
  awg: 'AWG',
  wdtt: 'WDTT',
  openflux: 'OpenFlux',
  naive: 'браузер',
};

const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}\u2026` : s);
const PAGE = 10;

function rate(bps: number | null): string {
  if (bps === null) return '';
  const mbit = (bps * 8) / 1e6;
  if (mbit >= 1) return `${(Math.round(mbit * 10) / 10).toString().replace('.', ',')}${NB}Мбит/с`;
  return `${Math.round((bps * 8) / 1e3)}${NB}кбит/с`;
}

function clientIcon(r: { enabled: boolean; states: Record<string, number> }): string {
  if (!r.enabled) return I.none;
  if ((r.states.error ?? 0) > 0) return I.bad;
  if ((r.states.pending ?? 0) > 0) return I.warn;
  return I.ok;
}

export function clientsView(rows: GClientRow[], f: { page: number; problems: boolean }): Screen {
  const list = f.problems ? rows.filter((r) => r.states.error > 0 || r.states.pending > 0) : rows;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const page = Math.min(Math.max(0, f.page), pages - 1);
  const items = list.slice(page * PAGE, page * PAGE + PAGE);
  const lines = [`<b>Клиенты</b>${f.problems ? `${SEP}с проблемами` : ''}${SEP}${list.length}`, ''];
  for (const r of items) {
    const dev = r.devices.length
      ? `${r.devices.length}${NB}${plural(r.devices.length, 'устройство', 'устройства', 'устройств')}`
      : 'без устройств';
    const st =
      r.states.error > 0
        ? `${SEP}ошибок ${r.states.error}`
        : r.states.pending > 0
          ? `${SEP}ждут ${r.states.pending}`
          : '';
    lines.push(
      `${clientIcon(r)} <b>${esc(r.name)}</b>${SEP}${dev}${r.enabled ? '' : `${SEP}выключен`}${st}`,
    );
  }
  if (!list.length) lines.push(f.problems ? 'Проблем нет' : 'Клиентов нет');
  const kb: Btn[][] = [];
  for (let i = 0; i < items.length; i += 2)
    kb.push(items.slice(i, i + 2).map((r) => ({ text: cut(r.name, 24), data: cb('gc', r.id) })));
  const fl = f.problems ? 1 : 0;
  const nav: Btn[] = [
    f.problems
      ? { text: 'Все', data: cb('gl', 0, 0) }
      : { text: 'С проблемами', data: cb('gl', 0, 1) },
  ];
  if (pages > 1) {
    nav.push({ text: I.prev, data: cb('gl', (page - 1 + pages) % pages, fl) });
    nav.push({ text: `${page + 1}/${pages}`, data: cb('gl', page, fl) });
    nav.push({ text: I.next, data: cb('gl', (page + 1) % pages, fl) });
  }
  kb.push(nav);
  kb.push([{ text: 'Новый клиент', data: cb('nc') }]);
  kb.push([{ text: `${I.back} Сводка`, data: cb('m') }]);
  return { text: lines.join('\n'), kb };
}

function devicesLine(d: GClientDetail): string {
  if (!d.devices.length) return 'Устройств нет';
  return `Устройства: ${d.devices.map((x) => `${esc(deviceLabel(x))}${x.awg20 ? ' (AWG 2.0)' : ''}`).join(', ')}`;
}

export function clientView(d: GClientDetail, rules: WatchRuleView[], c: Ctx): Screen {
  const cl = d.client;
  const st = { ok: 0, pending: 0, error: 0 };
  for (const b of d.bindings) st[b.state]++;
  const servers = new Set(d.bindings.map((b) => b.serverId)).size;
  const lines = [
    `<b>${esc(cl.name)}</b> ${cl.enabled ? `${I.ok} включён` : `${I.none} выключен`}`,
    devicesLine(d),
    cl.access === null
      ? 'Доступ: все серверы и сервисы'
      : `Доступ: выборочный, ${cl.access.length}${NB}${plural(cl.access.length, 'сервер', 'сервера', 'серверов')}`,
    `Привязки: ${st.ok} в порядке${st.pending ? `, ${st.pending} ждут` : ''}${st.error ? `, ${I.bad} ${st.error} с ошибкой` : ''}${SEP}${servers}${NB}${plural(servers, 'сервер', 'сервера', 'серверов')}`,
  ];
  for (const b of d.bindings.filter((x) => x.state === 'error').slice(0, 5))
    lines.push(
      `${I.bad} ${esc(b.serverName)}, ${SERVICE_TITLE[b.service]}: ${esc(cut(b.error, 120))}`,
    );
  if (cl.note) lines.push(`<i>${esc(cl.note)}</i>`);
  const on = rules.filter((r) => r.enabled).length;
  if (rules.length) lines.push(`Уведомления о подключении: ${on} из ${rules.length}`);
  if (d.syncing) lines.push(`${I.run} идёт синхронизация`);
  const kb: Btn[][] = [
    [
      { text: 'Ссылки', data: cb('gk', cl.id) },
      { text: 'Устройства', data: cb('gd', cl.id) },
    ],
    [
      { text: 'Сейчас на связи', data: cb('gn', cl.id) },
      { text: 'Уведомления', data: cb('gw', cl.id) },
    ],
    [
      cl.enabled
        ? { text: 'Выключить', data: cb('ge', cl.id, 0) }
        : { text: 'Включить', data: cb('ge', cl.id, 1) },
      { text: 'Новая ссылка', data: cb('gt', cl.id) },
    ],
  ];
  if (c.panelUrl.startsWith('https://'))
    kb.push([
      {
        text: 'Открыть в панели',
        url: new URL(`/clients/${encodeURIComponent(cl.id)}`, c.panelUrl).href,
      },
    ]);
  kb.push([
    { text: `${I.back} Клиенты`, data: cb('gl', 0, 0) },
    { text: 'Обновить', data: cb('gc', cl.id) },
  ]);
  return { text: lines.join('\n'), kb };
}

const backTo = (d: GClientDetail): Btn => ({
  text: `${I.back} ${cut(d.client.name, 20)}`,
  data: cb('gc', d.client.id),
});

export function devicesView(d: GClientDetail): Screen {
  const lines = [`<b>${esc(d.client.name)}</b>${DASH}устройства`, ''];
  for (const x of d.devices) {
    const n = d.bindings.filter((b) => b.deviceId === x.id).length;
    lines.push(
      `${esc(deviceLabel(x))}${x.awg20 ? ' (AWG 2.0)' : ''}${n ? `${SEP}привязок ${n}` : ''}`,
    );
  }
  if (!d.devices.length) lines.push('Устройств нет');
  const kb: Btn[][] = d.devices.map((x) => [
    { text: cut(deviceLabel(x), 30), data: cb('gv', d.client.id, x.id) },
  ]);
  kb.push([{ text: 'Новое устройство', data: cb('nd', d.client.id) }]);
  kb.push([backTo(d)]);
  return { text: lines.join('\n'), kb };
}

export function deviceView(d: GClientDetail, did: string): Screen | null {
  const x = d.devices.find((v) => v.id === did);
  if (!x) return null;
  const mine = d.bindings.filter((b) => b.deviceId === did);
  const lines = [`<b>${esc(d.client.name)}</b>${DASH}${esc(deviceLabel(x))}`, ''];
  for (const b of mine)
    lines.push(
      `${b.state === 'ok' ? I.ok : b.state === 'pending' ? I.warn : I.bad} ${SERVICE_TITLE[b.service]}${SEP}${esc(b.serverName)}`,
    );
  if (!mine.length) lines.push('Привязок устройства нет: VLESS, MTProxy и WDTT у клиента общие');
  const awg = mine.filter((b) => b.service === 'awg' && b.state === 'ok');
  const kb: Btn[][] = [];
  for (let i = 0; i < awg.length; i += 2)
    kb.push(
      awg.slice(i, i + 2).map((b) => ({
        text: `AWG ${cut(b.serverName, 16)} .conf`,
        data: cb('ga', d.client.id, b.id),
      })),
    );
  kb.push([{ text: `${I.back} Устройства`, data: cb('gd', d.client.id) }]);
  return { text: lines.join('\n'), kb };
}

/** Ссылки клиента: подписка и личная страница под спойлером, копирование - кнопками. */
export function linksView(d: GClientDetail): Screen {
  const s = d.subscription;
  return {
    text: [
      `<b>${esc(d.client.name)}</b>: ссылки`,
      '',
      `Подписка: <tg-spoiler>${esc(s.url)}</tg-spoiler>`,
      `Личная страница: <tg-spoiler>${esc(s.page)}</tg-spoiler>`,
      '',
      '<i>Сообщение удалится через 10 мин</i>',
    ].join('\n'),
    kb: [
      [{ text: 'Копировать подписку', copy: s.url }],
      [{ text: 'Копировать личную страницу', copy: s.page }],
      [{ text: 'QR подписки', data: cb('gq', d.client.id) }],
    ],
  };
}

export function liveView(d: GClientDetail, live: GClientLive, c: Ctx): Screen {
  const by = new Map(live.bindings.map((l) => [l.bindingId, l]));
  const lines = [`<b>${esc(d.client.name)}</b>${DASH}сейчас на связи`, ''];
  const online = d.bindings.filter((b) => by.get(b.id)?.state === 'online');
  for (const b of online) {
    const l = by.get(b.id);
    const dev = d.devices.find((x) => x.id === b.deviceId);
    const speed = l ? [rate(l.rateOut), rate(l.rateIn)].filter(Boolean).join(' / ') : '';
    lines.push(
      `${I.ok} ${dev ? `${esc(deviceLabel(dev))}${DASH}` : ''}${SERVICE_TITLE[b.service]}, ${esc(b.serverName)}${speed ? `${SEP}${speed}` : ''}`,
    );
  }
  if (!online.length) {
    const last = live.bindings
      .map((l) => l.lastSeen)
      .filter((v): v is string => Boolean(v))
      .sort()
      .at(-1);
    lines.push(`Не на связи${last ? `, последняя активность ${ago(last, c.now)}` : ''}`);
  }
  const off = live.servers.filter((s) => !s.online || s.error).length;
  if (off) lines.push('', `Не ответили серверов: ${off}`);
  lines.push('', `Снимок ${tgWhen(live.at, c.now)}`);
  return {
    text: lines.join('\n'),
    kb: [[backTo(d), { text: 'Обновить', data: cb('gn', d.client.id) }]],
  };
}

const EVENT: Record<string, string> = {
  down: 'отключение',
  up: 'подключение',
  both: 'отключение и подключение',
};

export function watchesView(d: GClientDetail, rules: WatchRuleView[]): Screen {
  const lines = [`<b>${esc(d.client.name)}</b>${DASH}уведомления о подключении`, ''];
  for (const r of rules) {
    const where = [
      r.serverName === null ? 'любой сервер' : esc(r.serverName || 'сервер удалён'),
      r.service ? SERVICE_TITLE[r.service] : 'любой сервис',
      r.deviceName === null ? '' : esc(r.deviceName || 'устройство удалено'),
    ]
      .filter(Boolean)
      .join(', ');
    const st =
      r.status === 'up'
        ? `${I.ok} на связи`
        : r.status === 'down'
          ? `${I.bad} нет связи${r.downSince ? ` с ${tgWhen(r.downSince, Date.now())}` : ''}`
          : 'неизвестно';
    lines.push(
      `${r.enabled ? '' : `${I.none} `}${where}: ${EVENT[r.event] ?? r.event}, ${r.delayMinutes}${NB}мин${SEP}${st}`,
    );
  }
  if (!rules.length) lines.push('Правил нет');
  const kb: Btn[][] = rules.map((r, i) => [
    {
      text: `${r.enabled ? 'Выключить' : 'Включить'} правило ${i + 1}`,
      data: cb('wt', r.id, r.enabled ? 0 : 1),
    },
  ]);
  kb.push([{ text: 'Уведомлять об отключении (10 мин)', data: cb('wn', d.client.id) }]);
  kb.push([backTo(d)]);
  return { text: lines.join('\n'), kb };
}

// ---- мастера: новый клиент и новое устройство ----

export function askName(): Screen {
  return {
    text: `<b>Новый клиент</b>\n\nИмя клиента${DASH}сообщением`,
    kb: [[{ text: 'Отмена', data: cb('fx') }]],
  };
}

export function askType(title: string, name: string): Screen {
  const kb: Btn[][] = [];
  for (let i = 0; i < DEVICES.length; i += 3)
    kb.push(DEVICES.slice(i, i + 3).map((x) => ({ text: x.title, data: cb('fy', x.id) })));
  kb.push([{ text: 'Без устройства', data: cb('fy', '-') }]);
  kb.push([{ text: 'Отмена', data: cb('fx') }]);
  return { text: `<b>${esc(title)}</b>${name ? ` ${q(esc(name))}` : ''}\n\nТип устройства:`, kb };
}

export function askDeviceName(title: string, type: string): Screen {
  return {
    text: `<b>${esc(title)}</b>\n\nИмя устройства (${esc(type)})${DASH}сообщением, например ${q('дача')}`,
    kb: [[{ text: 'Без имени', data: cb('fs') }], [{ text: 'Отмена', data: cb('fx') }]],
  };
}

export function created(name: string, id: string): Screen {
  return {
    text: `Клиент <b>${esc(name)}</b> создан: доступ ко всем серверам и сервисам, синхронизация запущена`,
    kb: [[{ text: 'Открыть клиента', data: cb('gc', id) }]],
  };
}
