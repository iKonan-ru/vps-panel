import {
  type ActionListRow,
  type BackupInfo,
  type BaselinePlan,
  type BotAdmin,
  type GClientRow,
  type ServerDetail,
  type ServerReach,
  type ServerSummary,
  type ServiceUpdate,
  type Tag,
  type TgHealthView,
  actionTitle,
} from '@vps/protocol';
import { daysToPayment } from '../lib/billing.js';
import { esc, tgSpan, tgWhen } from '../lib/telegram.js';
import { cb } from './codec.js';

/**
 * Экраны бота: чистые функции "данные API - текст и кнопки". Тексты - HTML Telegram, всё
 * пришедшее из данных - через esc(). В исходниках только клавиатурные символы: значки, тире и
 * кавычки - кодами.
 */

export interface Btn {
  text: string;
  data?: string;
  url?: string;
}
export interface Screen {
  text: string;
  kb: Btn[][];
}
export interface Ctx {
  now: number;
  /** адрес панели для кнопок "Открыть в панели" (только https) */
  panelUrl: string;
  /** короткая ссылка на значение, которое не помещается в callback_data */
  ref: (value: string) => string;
}

export const NB = '\u00a0';
export const DASH = '\u00a0\u2014 ';
export const SEP = ' \u00b7 ';
export const I = {
  ok: '\u{1F7E2}',
  bad: '\u{1F534}',
  warn: '\u{1F7E1}',
  none: '\u26aa',
  done: '\u2705',
  fail: '\u274c',
  run: '\u23f3',
  back: '\u2190',
  prev: '\u2039',
  next: '\u203a',
};
export const q = (s: string) => `\u00ab${s}\u00bb`;

/** Кнопки постоянного меню: их текст приходит сообщением. */
export const MENU = { summary: 'Сводка', servers: 'Серверы', log: 'Журнал', more: 'Ещё' };
export const MENU_KEYBOARD = {
  keyboard: [
    [{ text: MENU.summary }, { text: MENU.servers }],
    [{ text: MENU.log }, { text: MENU.more }],
  ],
  is_persistent: true,
  resize_keyboard: true,
};

/** Команды бота в меню слева от поля ввода (только в чате администратора). */
export const COMMANDS = [
  { command: 'menu', description: 'Сводка' },
  { command: 'servers', description: 'Серверы' },
  { command: 'log', description: 'Журнал действий' },
  { command: 'settings', description: 'Управление через бота' },
];

export function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

/** Ровно 1,2 ГБ: дробь через запятую, без лишнего нуля. */
function num(v: number, digits = 1): string {
  return (Math.round(v * 10 ** digits) / 10 ** digits).toString().replace('.', ',');
}

/** "5 мин назад"; давнее - временем по Москве. */
export function ago(iso: string | null, now: number): string {
  if (!iso) return '';
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'только что';
  if (ms < 24 * 3600_000) return `${tgSpan(ms)} назад`;
  return tgWhen(iso, now);
}

function cut(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}\u2026` : s;
}

function flag(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return '';
  const up = code.toUpperCase();
  return String.fromCodePoint(0x1f1e6 + up.charCodeAt(0) - 65, 0x1f1e6 + up.charCodeAt(1) - 65);
}

function country(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return code;
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' }).of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

/** Кнопка "Открыть в панели": Telegram принимает только настоящие адреса, локальные - нет. */
function panelLink(c: Ctx, path: string): Btn[] {
  if (!c.panelUrl.startsWith('https://')) return [];
  try {
    return [{ text: 'Открыть в панели', url: new URL(path, c.panelUrl).href }];
  } catch {
    return [];
  }
}

// ---- состояние серверов ----

type Level = 'ok' | 'partial' | 'bad' | 'none';

/** Доступность из России: от 80% - видно, от 50% - частично, ниже - не видно. */
export function reachLevel(percent: number | null): Level {
  if (percent === null) return 'none';
  if (percent >= 80) return 'ok';
  if (percent >= 50) return 'partial';
  return 'bad';
}
const levelIcon: Record<Level, string> = { ok: I.ok, partial: I.warn, bad: I.bad, none: I.none };

interface Problem {
  bad: boolean;
  text: string;
}

/**
 * Что на сервере требует внимания: не в сети, упавшие сервисы, критичные замечания, не виден
 * из России. Не в сети - только это (остальное устарело). Адрес не виден - inbound не
 * перечисляем (причина та же), MTProxyL - отдельно (его проверка своя).
 */
export function problems(s: ServerSummary, reach: ServerReach | null | undefined, now: number) {
  const out: Problem[] = [];
  if (s.status === 'offline') {
    const since = s.lastSeenAt ? ` ${tgSpan(now - Date.parse(s.lastSeenAt))}` : '';
    return [{ bad: true, text: `не в сети${since}` }];
  }
  if (s.status === 'no-agent') return [{ bad: false, text: 'агент не установлен' }];
  if (s.status === 'rebooting') out.push({ bad: false, text: 'перезагружается' });
  for (const sv of s.services)
    if (sv.details?.down === true) out.push({ bad: true, text: `${sv.title} не работает` });
  const pending = s.audit?.pendingUpdates ?? 0;
  const high = (s.audit?.findings ?? []).filter(
    (f) =>
      f.severity === 'high' && !(pending > 0 && f.text.startsWith('Ожидают установки обновлени')),
  );
  if (high.length) out.push({ bad: true, text: `критичных замечаний: ${high.length}` });
  const weak = (reach?.targets ?? []).filter((t) => {
    const lv = reachLevel(t.percent);
    return lv === 'bad' || lv === 'partial';
  });
  const ip = weak.find((t) => t.key === 'ip' && reachLevel(t.percent) === 'bad');
  for (const t of ip ? weak.filter((x) => x === ip || x.source === 'mtproxyl') : weak) {
    const bad = reachLevel(t.percent) === 'bad';
    const what = t.key === 'ip' ? 'адрес' : t.key === 'mtproxyl' ? 'MTProxyL' : t.title;
    out.push({ bad, text: `${what} ${bad ? 'не виден' : 'виден частично'} из России` });
  }
  return out;
}

/** Значок сервера в списках: не в сети - красный, есть проблемы - жёлтый. */
function serverIcon(s: ServerSummary, list: Problem[]): string {
  if (s.status === 'offline') return I.bad;
  if (s.status === 'no-agent') return I.none;
  if (s.status === 'rebooting' || list.length) return I.warn;
  return I.ok;
}

/** Задержка из России: у адреса сервера, иначе медиана целей. */
function rttOf(r: ServerReach | null | undefined): number | null {
  if (!r) return null;
  const ip = r.targets.find((t) => t.key === 'ip')?.rtt;
  if (ip) return ip;
  const v = r.targets.flatMap((t) => (t.rtt ? [t.rtt] : [])).sort((a, b) => a - b);
  if (!v.length) return null;
  const h = Math.floor(v.length / 2);
  return v.length % 2 ? (v[h] ?? null) : ((v[h - 1] ?? 0) + (v[h] ?? 0)) / 2;
}

function paymentWhen(days: number): string {
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${days}${NB}дн.`;
}

function money(price: number | null, currency: string): string {
  return price ? `${num(price, 2)}${NB}${esc(currency)}` : '';
}

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
  for (let i = 0; i < shown.length; i += 3)
    kb.push(
      shown.slice(i, i + 3).map(({ s, icon }) => ({
        text: `${icon} ${cut(s.name, 18)}`,
        data: cb('sv', s.id),
      })),
    );
  kb.push([
    { text: 'Серверы', data: cb('sl', '-', 0) },
    { text: 'Журнал', data: cb('lg', '-', 0) },
  ]);
  kb.push([{ text: 'Обновить', data: cb('m') }]);
  return { text: lines.join('\n'), kb };
}

// ---- список серверов ----

const PAGE = 8;

const tagEq = (a: string, b: string) => a.toLocaleLowerCase('ru') === b.toLocaleLowerCase('ru');

export function serversView(
  d: { servers: ServerSummary[]; reach: Record<string, ServerReach>; tags: Tag[] },
  f: { tag: string | null; page: number },
  c: Ctx,
): Screen {
  const list = f.tag
    ? d.servers.filter((s) => s.tags.some((t) => tagEq(t, f.tag ?? '')))
    : d.servers;
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const page = Math.min(Math.max(0, f.page), pages - 1);
  const items = list.slice(page * PAGE, page * PAGE + PAGE);
  const head = `<b>Серверы</b>${f.tag ? `${SEP}тег ${q(esc(f.tag))}` : ''}${SEP}${list.length}`;
  const lines = [head, ''];
  for (const s of items) {
    const pr = problems(s, d.reach[s.id], c.now);
    const icon = serverIcon(s, pr);
    let detail = pr[0]?.text ?? '';
    if (!detail && s.metrics) {
      const m = s.metrics;
      const ram = m.memTotalMb ? Math.round((m.memUsedMb / m.memTotalMb) * 100) : 0;
      const rtt = rttOf(d.reach[s.id]);
      detail = `CPU ${Math.round(m.cpuPercent)}%${SEP}RAM ${ram}%${rtt ? `${SEP}из РФ ${Math.round(rtt)}${NB}мс` : ''}`;
    }
    lines.push(`${icon} <b>${esc(s.name)}</b>${detail ? `${SEP}${esc(detail)}` : ''}`);
  }
  if (!list.length) lines.push(f.tag ? 'С этим тегом серверов нет' : 'Серверов нет');

  const tagRef = f.tag ? c.ref(f.tag) : '-';
  const kb: Btn[][] = [];
  for (let i = 0; i < items.length; i += 2)
    kb.push(items.slice(i, i + 2).map((s) => ({ text: cut(s.name, 24), data: cb('sv', s.id) })));
  const nav: Btn[] = [];
  if (d.tags.length) nav.push({ text: `Тег: ${cut(f.tag ?? 'все', 16)}`, data: cb('tg', tagRef) });
  if (pages > 1) {
    nav.push({ text: I.prev, data: cb('sl', tagRef, (page - 1 + pages) % pages) });
    nav.push({ text: `${page + 1}/${pages}`, data: cb('sl', tagRef, page) });
    nav.push({ text: I.next, data: cb('sl', tagRef, (page + 1) % pages) });
  }
  if (nav.length) kb.push(nav);
  kb.push([{ text: `${I.back} Сводка`, data: cb('m') }]);
  return { text: lines.join('\n'), kb };
}

export function tagsView(
  d: { servers: ServerSummary[]; tags: Tag[] },
  current: string | null,
  c: Ctx,
) {
  const count = (t: string) => d.servers.filter((s) => s.tags.some((x) => tagEq(x, t))).length;
  const btns: Btn[] = [
    { text: `${current ? '' : '\u2022 '}Все (${d.servers.length})`, data: cb('sl', '-', 0) },
    ...d.tags.map((t) => ({
      text: `${current && tagEq(current, t.name) ? '\u2022 ' : ''}${cut(t.name, 20)} (${count(t.name)})`,
      data: cb('sl', c.ref(t.name), 0),
    })),
  ];
  const kb: Btn[][] = [];
  for (let i = 0; i < btns.length; i += 2) kb.push(btns.slice(i, i + 2));
  kb.push([{ text: `${I.back} Серверы`, data: cb('sl', current ? c.ref(current) : '-', 0) }]);
  return { text: '<b>Серверы с тегом</b>', kb };
}

// ---- карточка сервера ----

export function serverView(
  d: { s: ServerDetail; reach: ServerReach | null; updates: ServiceUpdate[] },
  c: Ctx,
): Screen {
  const { s } = d;
  const status =
    s.status === 'online'
      ? `${I.ok} в сети`
      : s.status === 'offline'
        ? `${I.bad} не в сети${s.lastSeenAt ? ` ${tgSpan(c.now - Date.parse(s.lastSeenAt))}, с ${tgWhen(s.lastSeenAt, c.now)}` : ''}`
        : s.status === 'rebooting'
          ? `${I.warn} перезагружается`
          : `${I.none} агент не установлен`;
  const tags = s.tags.length ? `${SEP}<i>${esc(s.tags.join(', '))}</i>` : '';
  const lines = [`<b>${esc(s.name)}</b> ${status}${tags}`];
  const where = [`<code>${esc(s.host)}</code>`];
  if (s.hosting.country)
    where.push(`${flag(s.hosting.country)} ${esc(country(s.hosting.country))}`);
  if (s.hosting.provider) where.push(esc(s.hosting.provider));
  lines.push(where.join(SEP));
  const m = s.metrics;
  if (m && s.status === 'online') {
    const gb = (mb: number) => num(mb / 1024);
    lines.push(
      [
        `CPU ${Math.round(m.cpuPercent)}%`,
        `RAM ${gb(m.memUsedMb)}/${gb(m.memTotalMb)}${NB}ГБ`,
        `диск ${Math.round(m.diskUsedGb)}/${Math.round(m.diskTotalGb)}${NB}ГБ`,
        `${tgSpan(m.uptimeSec * 1000)} без перезагрузки`,
      ].join(SEP),
    );
  }
  lines.push('');

  if (s.services.length) {
    const sv = s.services.map((x) => {
      if (x.details?.down !== true) return `${esc(x.title)} ${I.ok}`;
      const why = typeof x.details.downReason === 'string' ? `: ${esc(x.details.downReason)}` : '';
      return `${esc(x.title)} ${I.bad} не работает${why}`;
    });
    lines.push(`<b>Сервисы:</b> ${sv.join(', ')}`);
  }
  const targets = d.reach?.targets ?? [];
  if (targets.length) {
    const parts: string[] = [];
    const ip = targets.find((t) => t.key === 'ip');
    if (ip)
      parts.push(
        `адрес ${levelIcon[reachLevel(ip.percent)]}${ip.percent === null ? '' : ` ${ip.percent}%`}`,
      );
    const xui = targets.filter((t) => t.key.startsWith('xui:'));
    if (xui.length) {
      const order: Level[] = ['bad', 'partial', 'none', 'ok'];
      const worst = order.find((lv) => xui.some((t) => reachLevel(t.percent) === lv)) ?? 'ok';
      const ok = xui.filter((t) => reachLevel(t.percent) === 'ok').length;
      parts.push(`inbound ${levelIcon[worst]} ${ok}/${xui.length}`);
    }
    const mt = targets.find((t) => t.key === 'mtproxyl');
    if (mt) parts.push(`MTProxyL ${levelIcon[reachLevel(mt.percent)]}`);
    lines.push(`<b>Из России:</b> ${parts.join(', ')}`);
  }
  if (s.audit) {
    const pending = s.audit.pendingUpdates;
    const f = s.audit.findings.filter(
      (x) => !(pending > 0 && x.text.startsWith('Ожидают установки обновлени')),
    );
    const high = f.filter((x) => x.severity === 'high').length;
    const medium = f.filter((x) => x.severity === 'medium').length;
    const sec: string[] = [];
    if (high) sec.push(`${I.bad} критичных${NB}${high}`);
    if (medium) sec.push(`замечаний${NB}${medium}`);
    if (!high && !medium) sec.push('замечаний нет');
    if (s.firewall) sec.push(s.firewall.ufwActive ? 'ufw включён' : 'ufw выключен');
    const banned = s.audit.jails.reduce((a, j) => a + j.banned, 0);
    if (banned) sec.push(`в бане fail2ban${NB}${banned}`);
    lines.push(`<b>Безопасность:</b> ${sec.join(', ')}`);
  }
  const upd: string[] = d.updates.map(
    (u) => `${esc(u.title)} ${esc(u.latest)}${u.current ? ` (сейчас ${esc(u.current)})` : ''}`,
  );
  if ((s.audit?.pendingUpdates ?? 0) > 0)
    upd.push(`пакеты безопасности${DASH}${s.audit?.pendingUpdates}`);
  if (s.audit?.rebootRequired) upd.push('нужна перезагрузка');
  if (s.agentUpdating) upd.push('агент обновляется');
  else if (s.agentUpdateAvailable) upd.push('новая версия агента');
  if (upd.length) lines.push(`<b>Обновления:</b> ${upd.join(', ')}`);
  if (s.hosting.nextPaymentAt) {
    const days = daysToPayment(s.hosting.nextPaymentAt, c.now);
    const d8 = new Date(s.hosting.nextPaymentAt);
    const date = `${String(d8.getUTCDate()).padStart(2, '0')}.${String(d8.getUTCMonth() + 1).padStart(2, '0')}`;
    const price = money(s.hosting.price, s.hosting.currency);
    const soon = days >= 0 && days <= 7 ? `, ${paymentWhen(days)}` : '';
    lines.push(`<b>Оплата:</b> ${date}${soon}${price ? `, ${price}` : ''}`);
  }
  if (s.agentVersion) lines.push(`<b>Агент:</b> ${esc(s.agentVersion)}`);
  if (s.activeActions.length)
    lines.push(`<b>Сейчас:</b> ${s.activeActions.map((a) => esc(a.title)).join('; ')}`);

  const kb: Btn[][] = [];
  if (s.status === 'online')
    kb.push([
      { text: 'Обслуживание', data: cb('mt', s.id) },
      { text: 'Безопасность', data: cb('sc', s.id) },
    ]);
  const row: Btn[] = [];
  if (s.status === 'online' && (s.inventory?.containers.length ?? 0) > 0)
    row.push({ text: 'Docker', data: cb('dk', s.id) });
  if (targets.length) row.push({ text: 'Доступность', data: cb('rc', s.id) });
  if (row.length) kb.push(row);
  kb.push([
    { text: 'Резервные копии', data: cb('bk', s.id) },
    { text: 'Журнал', data: cb('lg', s.id, 0) },
  ]);
  const link = panelLink(c, `/servers/${encodeURIComponent(s.id)}`);
  if (link.length) kb.push(link);
  kb.push([
    { text: `${I.back} Серверы`, data: cb('sl', '-', 0) },
    { text: 'Обновить', data: cb('sv', s.id) },
  ]);
  return { text: lines.join('\n'), kb };
}

// ---- доступность из России ----

export function reachView(d: { s: ServerSummary; r: ServerReach | null }, c: Ctx): Screen {
  const lines = [`<b>${esc(d.s.name)}</b>${DASH}доступность из России`, ''];
  const targets = d.r?.targets ?? [];
  for (const t of targets) {
    const icon = levelIcon[reachLevel(t.percent)];
    const res = t.percent === null ? 'ещё не проверен' : `${t.percent}% (${t.ok}/${t.total})`;
    const rtt = t.rtt ? `${SEP}${Math.round(t.rtt)}${NB}мс` : '';
    lines.push(`${icon} ${esc(t.title)}${DASH}${res}${rtt}`);
    const why = t.error ?? (reachLevel(t.percent) === 'bad' ? t.errors[0] : undefined);
    if (why) lines.push(`<i>${esc(why)}</i>`);
  }
  if (!targets.length) lines.push('Проверок ещё не было');
  if (d.r?.error) lines.push('', `Проверка не удалась: ${esc(d.r.error)}`);
  if (d.r?.checkedAt) lines.push('', `Проверено ${ago(d.r.checkedAt, c.now)}`);
  return {
    text: lines.join('\n'),
    kb: [
      [
        { text: `${I.back} ${cut(d.s.name, 20)}`, data: cb('sv', d.s.id) },
        { text: 'Обновить', data: cb('rc', d.s.id) },
      ],
    ],
  };
}

// ---- журнал действий ----

const LOG_PAGE = 10;

function actionIcon(a: { finishedAt: string | null; exitCode: number | null }): string {
  if (!a.finishedAt) return I.run;
  return a.exitCode === 0 ? I.done : I.fail;
}

export function journalView(
  d: { rows: ActionListRow[]; names: Map<string, string>; serverId: string | null },
  page: number,
  c: Ctx,
): Screen {
  const pages = Math.max(1, Math.ceil(d.rows.length / LOG_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const items = d.rows.slice(p * LOG_PAGE, p * LOG_PAGE + LOG_PAGE);
  const own = d.serverId ? (d.names.get(d.serverId) ?? '') : '';
  const text = `<b>Журнал действий</b>${own ? `${SEP}${esc(own)}` : ''}${d.rows.length ? '' : '\n\nДействий пока нет'}`;
  const from = d.serverId ? 's' : 'g';
  const kb: Btn[][] = items.map((a) => {
    const sv = !d.serverId && a.serverId ? d.names.get(a.serverId) : '';
    return [
      {
        text: cut(
          `${actionIcon(a)} ${tgWhen(a.startedAt, c.now)} ${actionTitle(a.kind, a.params)}${sv ? ` (${sv})` : ''}`,
          60,
        ),
        data: cb('ac', a.id, from),
      },
    ];
  });
  const sid = d.serverId ?? '-';
  if (pages > 1)
    kb.push([
      { text: I.prev, data: cb('lg', sid, (p - 1 + pages) % pages) },
      { text: `${p + 1}/${pages}`, data: cb('lg', sid, p) },
      { text: I.next, data: cb('lg', sid, (p + 1) % pages) },
    ]);
  kb.push(
    d.serverId
      ? [{ text: `${I.back} ${cut(own, 20)}`, data: cb('sv', d.serverId) }]
      : [{ text: `${I.back} Сводка`, data: cb('m') }],
  );
  return { text, kb };
}

/** Хвост вывода: целые строки, не длиннее max символов. */
export function tail(out: string, max = 3000): string {
  const t = out.replace(/\r/g, '').replace(/\n+$/, '');
  if (t.length <= max) return t;
  const s = t.slice(-max);
  const nl = s.indexOf('\n');
  return nl >= 0 && nl < s.length - 1 ? s.slice(nl + 1) : s;
}

export function actionView(
  d: {
    a: ActionListRow & { output: string };
    serverName: string | null;
    from: 'g' | 's';
  },
  c: Ctx,
): Screen {
  const { a } = d;
  const lines = [
    `<b>${esc(actionTitle(a.kind, a.params))}</b>${d.serverName ? `${SEP}${esc(d.serverName)}` : ''}`,
  ];
  if (a.finishedAt) {
    const dur = tgSpan(Date.parse(a.finishedAt) - Date.parse(a.startedAt));
    const res =
      a.exitCode === 0 ? 'готово' : `ошибка${a.exitCode !== null ? `, код ${a.exitCode}` : ''}`;
    lines.push(`${actionIcon(a)} ${res}${SEP}${tgWhen(a.startedAt, c.now)}, ${dur}`);
  } else {
    lines.push(
      `${I.run} идёт ${tgSpan(c.now - Date.parse(a.startedAt))}${SEP}с ${tgWhen(a.startedAt, c.now)}`,
    );
  }
  const out = tail(a.output);
  if (out) lines.push('', `<pre>${esc(out)}</pre>`);
  const back: Btn =
    d.from === 's' && a.serverId
      ? { text: `${I.back} Журнал сервера`, data: cb('lg', a.serverId, 0) }
      : { text: `${I.back} Журнал`, data: cb('lg', '-', 0) };
  const row: Btn[] = [back];
  if (!a.finishedAt) row.push({ text: 'Обновить', data: cb('ac', a.id, d.from) });
  const kb: Btn[][] = [row];
  if (a.finishedAt && a.output.trim().length > out.length)
    kb.unshift([{ text: 'Вывод файлом', data: cb('af', a.id) }]);
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
  const kb: Btn[][] = [[{ text: 'Отключить управление', data: cb('off') }]];
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

export function searchView(query: string, found: ServerSummary[]): Screen {
  if (!found.length)
    return { text: `Ничего не найдено по запросу ${q(esc(cut(query, 60)))}`, kb: [] };
  const kb: Btn[][] = [];
  for (let i = 0; i < Math.min(found.length, 20); i += 2)
    kb.push(found.slice(i, i + 2).map((s) => ({ text: cut(s.name, 24), data: cb('sv', s.id) })));
  return { text: `Найдено серверов: ${found.length}`, kb };
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

// ---- баны и план исправления ----

export function bansView(s: ServerDetail, c: Ctx): Screen {
  const lines = [`<b>${esc(s.name)}</b>${DASH}баны fail2ban`, ''];
  const kb: Btn[][] = [];
  const jails = s.audit?.jails ?? [];
  for (const j of jails) {
    lines.push(`<b>${esc(j.name)}</b>: сейчас ${j.banned}, всего ${j.totalBanned}`);
    for (const ip of j.bannedIps.slice(0, 15)) {
      if (kb.length < 20)
        kb.push([
          {
            text: `Снять бан ${ip}`,
            data: cb('ub', c.ref(JSON.stringify({ sid: s.id, jail: j.name, ip }))),
          },
        ]);
    }
    if (j.bannedIps.length > 15) lines.push(`и ещё ${j.bannedIps.length - 15}`);
  }
  if (!jails.length) lines.push('fail2ban не настроен');
  kb.push([{ text: `${I.back} ${cut(s.name, 20)}`, data: cb('sv', s.id) }]);
  return { text: lines.join('\n'), kb };
}

export function planView(s: { id: string; name: string }, plan: BaselinePlan, c: Ctx): Screen {
  const need = plan.steps.filter((x) => x.needed);
  const lines = [`<b>${esc(s.name)}</b>${DASH}исправление проблем`, ''];
  for (const st of need) lines.push(`- ${esc(st.title)}${st.detail ? `: ${esc(st.detail)}` : ''}`);
  if (!need.length) lines.push('Исправлять нечего');
  const ports = plan.ports.map(
    (p) => `${p.action === 'open' ? 'открыть' : 'закрыть'} ${p.port}/${p.proto}`,
  );
  if (ports.length) lines.push('', `Порты: ${esc(ports.join(', '))}`);
  if (plan.blockers.length) lines.push('', `Нельзя: ${esc(plan.blockers.join('; '))}`);
  const kb: Btn[][] = [];
  if (need.length && plan.canApply) kb.push([{ text: 'Исправить', data: cb('bf', s.id) }]);
  kb.push([{ text: `${I.back} ${cut(s.name, 20)}`, data: cb('sv', s.id) }]);
  void c;
  return { text: lines.join('\n'), kb };
}

// ---- подтверждение, код 2FA, ход действия ----

export function confirmView(question: string, verb: string, token: string): Screen {
  return {
    text: question,
    kb: [
      [
        { text: verb, data: cb('cf', token) },
        { text: 'Отмена', data: cb('cx', token) },
      ],
    ],
  };
}

export function codeView(question: string, token: string, note = ''): Screen {
  return {
    text: `${question}\n\n${note ? `${note}\n` : ''}Код двухфакторной аутентификации${DASH}сообщением. Следующие 10${NB}минут код не понадобится.`,
    kb: [[{ text: 'Отмена', data: cb('cx', token) }]],
  };
}

/** Ход действия: заголовок, сколько идёт, хвост вывода. */
export function progressText(header: string, startedAt: number, out: string, now: number): string {
  const t = tail(out, 1200);
  return `${header} ${I.run} идёт ${tgSpan(now - startedAt)}${t ? `\n<pre>${esc(t)}</pre>` : ''}`;
}

export function finalText(
  header: string,
  a: { exitCode: number | null; startedAt: string; finishedAt: string | null; output: string },
): string {
  const ok = a.exitCode === 0;
  const dur = a.finishedAt ? `, ${tgSpan(Date.parse(a.finishedAt) - Date.parse(a.startedAt))}` : '';
  const res = ok
    ? `${I.done} готово`
    : `${I.fail} ошибка${a.exitCode !== null ? `, код ${a.exitCode}` : ''}`;
  const t = tail(a.output, 1500);
  return `${header} ${res}${dur}${t ? `\n<pre>${esc(t)}</pre>` : ''}`;
}

// ---- обслуживание, безопасность, Docker, резервные копии ----

const back = (s: { id: string; name: string }): Btn[] => [
  { text: `${I.back} ${cut(s.name, 20)}`, data: cb('sv', s.id) },
];

const UPD_CODE: Record<string, string> = {
  xui: 'x',
  xray: 'y',
  mtproxyl: 'm',
  'mtproxyl-panel': 'p',
};

export function maintenanceView(d: { s: ServerDetail; updates: ServiceUpdate[] }): Screen {
  const { s } = d;
  const lines = [`<b>${esc(s.name)}</b>${DASH}обслуживание`, ''];
  const pending = s.audit?.pendingUpdates ?? 0;
  lines.push(pending ? `Обновления безопасности: ${pending}` : 'Обновлений безопасности нет');
  if (s.audit?.rebootRequired) lines.push('Нужна перезагрузка: обновлено ядро или библиотеки');
  for (const u of d.updates)
    lines.push(
      `${esc(u.title)}: ${esc(u.latest)}${u.current ? ` (сейчас ${esc(u.current)})` : ''}`,
    );
  if (s.metrics)
    lines.push(
      `Диск: ${Math.round(s.metrics.diskUsedGb)} из ${Math.round(s.metrics.diskTotalGb)}${NB}ГБ`,
    );
  lines.push(
    `Агент: ${esc(s.agentVersion ?? '')}${s.agentUpdateAvailable ? ', есть новая версия' : ''}`,
  );
  const kb: Btn[][] = [
    [
      { text: 'Обновить пакеты', data: cb('pu', s.id) },
      { text: 'Перезагрузить', data: cb('rb', s.id) },
    ],
    [
      { text: 'Очистить диск', data: cb('cl', s.id) },
      { text: 'Проверить обновления', data: cb('uc', s.id) },
    ],
  ];
  for (const u of d.updates) {
    const code = UPD_CODE[u.kind];
    if (code) kb.push([{ text: `Обновить ${u.title} до ${u.latest}`, data: cb('up', s.id, code) }]);
  }
  if (s.agentUpdateAvailable && !s.agentUpdating)
    kb.push([{ text: 'Обновить агент', data: cb('au', s.id) }]);
  kb.push(back(s));
  return { text: lines.join('\n'), kb };
}

export function securityView(s: ServerDetail): Screen {
  const lines = [`<b>${esc(s.name)}</b>${DASH}безопасность`, ''];
  const f = s.audit?.findings ?? [];
  const sev = { high: I.bad, medium: I.warn, info: I.none } as const;
  for (const x of f.slice(0, 15)) lines.push(`${sev[x.severity]} ${esc(x.text)}`);
  if (!f.length) lines.push('Замечаний нет');
  lines.push('');
  if (s.firewall) lines.push(`Firewall: ${s.firewall.ufwActive ? 'включён' : 'выключен'}`);
  if (s.audit) {
    const banned = s.audit.jails.reduce((a, j) => a + j.banned, 0);
    lines.push(
      `fail2ban: ${s.audit.fail2banRunning ? `работает, в бане ${banned}` : 'не работает'}`,
      `SSH: порт ${s.audit.sshPort}, вход по паролю ${s.audit.sshPasswordAuth ? 'включён' : 'выключен'}`,
    );
  }
  const kb: Btn[][] = [
    [
      { text: 'План исправления', data: cb('pl', s.id) },
      { text: 'Баны', data: cb('bn', s.id) },
    ],
  ];
  if (s.firewall)
    kb.push([
      s.firewall.ufwActive
        ? { text: 'Выключить firewall', data: cb('fd', s.id) }
        : { text: 'Включить firewall', data: cb('fe', s.id) },
    ]);
  kb.push(back(s));
  return { text: lines.join('\n'), kb };
}

const STATE: Record<string, string> = {
  running: 'работает',
  exited: 'остановлен',
  restarting: 'перезапускается',
  paused: 'приостановлен',
  created: 'создан',
  removing: 'удаляется',
  dead: 'сбой',
};

export function dockerView(s: ServerDetail): Screen {
  const list = s.inventory?.containers ?? [];
  const lines = [`<b>${esc(s.name)}</b>${DASH}Docker`, ''];
  for (const c of list)
    lines.push(
      `${c.state === 'running' ? I.ok : I.bad} ${esc(c.name)}${SEP}${STATE[c.state] ?? c.state}`,
    );
  if (!list.length) lines.push('Контейнеров нет');
  const kb: Btn[][] = [];
  for (let i = 0; i < Math.min(list.length, 30); i += 2)
    kb.push(
      list.slice(i, i + 2).map((c) => ({ text: cut(c.name, 24), data: cb('dc', s.id, c.id) })),
    );
  kb.push(back(s));
  return { text: lines.join('\n'), kb };
}

export function containerView(s: ServerDetail, cid: string): Screen | null {
  const c = s.inventory?.containers.find((x) => x.id === cid);
  if (!c) return null;
  const lines = [
    `<b>${esc(s.name)}</b>${DASH}${esc(c.name)}`,
    `${c.state === 'running' ? I.ok : I.bad} ${STATE[c.state] ?? c.state}${SEP}${esc(c.status)}`,
    `Образ: <code>${esc(c.image)}</code>`,
  ];
  if (c.published.length) lines.push(`Порты: ${esc(c.published.join(', '))}`);
  if (c.cpuPercent !== undefined || c.memMb !== undefined)
    lines.push(
      [
        c.cpuPercent !== undefined ? `CPU ${Math.round(c.cpuPercent)}%` : '',
        c.memMb !== undefined ? `RAM ${Math.round(c.memMb)}${NB}МБ` : '',
      ]
        .filter(Boolean)
        .join(SEP),
    );
  const running = c.state === 'running';
  const kb: Btn[][] = [
    running
      ? [
          { text: 'Перезапустить', data: cb('dr', s.id, c.id) },
          { text: 'Остановить', data: cb('ds', s.id, c.id) },
        ]
      : [{ text: 'Запустить', data: cb('dt', s.id, c.id) }],
    [{ text: 'Журнал контейнера', data: cb('dl', s.id, c.id) }],
    [{ text: `${I.back} Docker`, data: cb('dk', s.id) }],
  ];
  return { text: lines.join('\n'), kb };
}

export function logsView(
  s: { id: string; name: string },
  c: { id: string; name: string },
  text: string,
): Screen {
  const t = tail(text, 3200);
  return {
    text: `<b>${esc(s.name)}</b>${DASH}${esc(c.name)}, журнал${t ? `\n<pre>${esc(t)}</pre>` : '\nпусто'}`,
    kb: [
      [
        { text: `${I.back} ${cut(c.name, 20)}`, data: cb('dc', s.id, c.id) },
        { text: 'Обновить', data: cb('dl', s.id, c.id) },
      ],
    ],
  };
}

export function backupsView(s: ServerDetail, list: BackupInfo[], c: Ctx): Screen {
  const mine = list.filter((b) => b.serverId === s.id).slice(0, 10);
  const lines = [`<b>${esc(s.name)}</b>${DASH}резервные копии`, ''];
  for (const b of mine)
    lines.push(
      `${tgWhen(b.createdAt, c.now)}${SEP}${Math.max(1, Math.round(b.size / 1024 ** 2))}${NB}МБ`,
    );
  if (!mine.length) lines.push('Копий нет');
  const kb: Btn[][] = [];
  if (s.status === 'online') kb.push([{ text: 'Создать резервную копию', data: cb('bc', s.id) }]);
  kb.push(back(s));
  return { text: lines.join('\n'), kb };
}
