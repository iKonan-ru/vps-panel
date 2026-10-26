import type {
  BackupInfo,
  BaselinePlan,
  ServerDetail,
  ServerReach,
  ServerSummary,
  ServiceUpdate,
  Tag,
} from '@vps/protocol';
import { daysToPayment } from '../../lib/billing.js';
import { esc, tgSpan, tgWhen } from '../../lib/telegram.js';
import { cb } from '../codec.js';
import { UPDATE } from '../notify-buttons.js';
import {
  type Btn,
  type Ctx,
  DASH,
  I,
  NB,
  SEP,
  type Screen,
  ago,
  country,
  cut,
  flag,
  grid,
  num,
  panelLink,
  q,
  tail,
  toServer,
} from './common.js';

/** Экраны серверов: список, карточка, доступность, обслуживание, безопасность, Docker, копии. */

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

export interface Problem {
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
export function serverIcon(s: ServerSummary, list: Problem[]): string {
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

export function paymentWhen(days: number): string {
  if (days === 0) return 'сегодня';
  if (days === 1) return 'завтра';
  return `через ${days}${NB}дн.`;
}

export function money(price: number | null, currency: string): string {
  return price ? `${num(price, 2)}${NB}${esc(currency)}` : '';
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
  kb.push(
    ...grid(
      items.map((s) => ({ text: cut(s.name, 24), data: cb('sv', s.id) })),
      2,
    ),
  );
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
  kb.push(...grid(btns, 2));
  kb.push([{ text: `${I.back} Серверы`, data: cb('sl', current ? c.ref(current) : '-', 0) }]);
  return { text: '<b>Серверы с тегом</b>', kb };
}

// ---- карточка сервера ----

export function serverView(
  d: {
    s: ServerDetail;
    reach: ServerReach | null;
    updates: ServiceUpdate[];
    /** кнопки сервисов, что стоят на сервере */
    services?: Btn[];
  },
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
  const svc = s.status === 'online' ? (d.services ?? []) : [];
  kb.push(...grid(svc, 3));
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
  // сервер не в сети - "Обслуживания" нет, удалить из панели - отсюда
  if (s.status !== 'online') kb.push([{ text: 'Удалить из панели', data: cb('rm', s.id) }]);
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
      [{ text: 'Сменить IP', data: cb('ic', d.s.id) }],
      [toServer(d.s), { text: 'Обновить', data: cb('rc', d.s.id) }],
    ],
  };
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
  kb.push([toServer(s)]);
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
  kb.push([toServer(s)]);
  void c;
  return { text: lines.join('\n'), kb };
}

// ---- обслуживание, безопасность, Docker, резервные копии ----

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
    const code = UPDATE[u.kind]?.code;
    if (code) kb.push([{ text: `Обновить ${u.title} до ${u.latest}`, data: cb('up', s.id, code) }]);
  }
  if (s.agentUpdateAvailable && !s.agentUpdating)
    kb.push([{ text: 'Обновить агент', data: cb('au', s.id) }]);
  kb.push([{ text: 'Удалить из панели', data: cb('rm', s.id) }]);
  kb.push([toServer(s)]);
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
  kb.push([toServer(s)]);
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
  kb.push(
    ...grid(
      list.slice(0, 30).map((c) => ({ text: cut(c.name, 24), data: cb('dc', s.id, c.id) })),
      2,
    ),
  );
  kb.push([toServer(s)]);
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
  kb.push([toServer(s)]);
  return { text: lines.join('\n'), kb };
}
