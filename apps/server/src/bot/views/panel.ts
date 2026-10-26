import {
  type GSyncState,
  NOTIFY_GROUPS,
  type NotifyEvents,
  type PanelUpdateView,
  type TgHealthView,
  type XrayStatus,
} from '@vps/protocol';
import { esc, tgWhen } from '../../lib/telegram.js';
import { cb } from '../codec.js';
import { type Btn, type Ctx, I, NB, SEP, type Screen, ago } from './common.js';

/** Экраны раздела "Ещё": версия панели, резервная копия, уведомления, синхронизация, сессии. */

const toSettings: Btn = { text: `${I.back} Управление`, data: cb('st') };

export function versionView(v: PanelUpdateView, c: Ctx): Screen {
  const lines = [
    '<b>Версия панели</b>',
    '',
    `Сейчас ${esc(v.current)}${SEP}канал ${v.channel === 'beta' ? 'предварительный' : 'стабильный'}`,
  ];
  if (v.newer.length)
    lines.push(
      `Доступны: ${v.newer
        .slice(0, 5)
        .map((r) => esc(r.version))
        .join(', ')}`,
    );
  else lines.push('Новых версий нет');
  lines.push(`Автоматическое обновление: ${v.autoUpdate ? 'включено' : 'выключено'}`);
  if (v.requested) lines.push(`${I.run} обновление до ${esc(v.requested)} запрошено`);
  if (v.checkedAt) lines.push(`Проверено ${ago(v.checkedAt, c.now)}`);
  if (v.error) lines.push(`${I.bad} ${esc(v.error)}`);
  if (!v.managed) lines.push('Панель установлена не из релиза: обновление только в консоли');
  const kb: Btn[][] = [];
  const top = v.newer[0];
  if (top && v.managed)
    kb.push([{ text: `Обновить до ${top.version}`, data: cb('pv', c.ref(top.version)) }]);
  kb.push([{ text: 'Проверить обновления', data: cb('vc') }]);
  kb.push([
    v.channel === 'beta'
      ? { text: 'Канал: стабильный', data: cb('vh', 'stable') }
      : { text: 'Канал: предварительный', data: cb('vh', 'beta') },
    v.autoUpdate
      ? { text: 'Выключить автообновление', data: cb('va', 0) }
      : { text: 'Включить автообновление', data: cb('va', 1) },
  ]);
  kb.push([toSettings]);
  return { text: lines.join('\n'), kb };
}

export function backupView(
  b: {
    passwordSet: boolean;
    telegram: boolean;
    last: { at: string; to: string; ok: boolean; size?: number; error?: string } | null;
  },
  c: Ctx,
): Screen {
  const lines = ['<b>Резервная копия панели</b>', ''];
  lines.push(b.passwordSet ? 'Пароль задан' : `${I.warn} пароль не задан: копии не создаются`);
  lines.push(`Ежедневная отправка в Telegram: ${b.telegram ? 'включена' : 'выключена'}`);
  if (b.last)
    lines.push(
      `Последняя: ${tgWhen(b.last.at, c.now)}, ${b.last.to === 'telegram' ? 'в Telegram' : 'скачана'}${SEP}${b.last.ok ? `${I.ok}${b.last.size ? ` ${Math.max(1, Math.round(b.last.size / 1024 ** 2))}${NB}МБ` : ''}` : `${I.bad} ${esc(b.last.error ?? '')}`}`,
    );
  const kb: Btn[][] = [];
  if (b.passwordSet) kb.push([{ text: 'Отправить сейчас', data: cb('bp') }]);
  kb.push([toSettings]);
  return { text: lines.join('\n'), kb };
}

/** Уведомления: события группами, переключатели кнопками. */
export function notifyView(events: NotifyEvents): Screen {
  const lines = ['<b>Уведомления</b>'];
  const kb: Btn[][] = [];
  let i = 0;
  for (const g of NOTIFY_GROUPS) {
    lines.push('', `<b>${esc(g.title)}</b>`);
    for (const e of g.events) {
      const on = events[e.key];
      lines.push(`${on ? I.ok : I.none} ${esc(e.title)}`);
      kb.push([
        { text: `${on ? 'Выключить' : 'Включить'}: ${e.title}`, data: cb('nt', i, on ? 0 : 1) },
      ]);
      i++;
    }
  }
  kb.push([{ text: 'Отправить тестовое сообщение', data: cb('nx') }]);
  kb.push([toSettings]);
  return { text: lines.join('\n'), kb };
}

/** Событие по номеру в каталоге (кнопки уведомлений хранят номер, не ключ). */
export function eventAt(i: number): string | null {
  return NOTIFY_GROUPS.flatMap((g) => g.events.map((e) => e.key))[i] ?? null;
}

export function syncView(s: GSyncState, c: Ctx): Screen {
  const lines = ['<b>Синхронизация клиентов</b>', ''];
  if (s.syncing) {
    lines.push(
      `${I.run} выполняется${s.startedAt ? ` с ${tgWhen(s.startedAt, c.now)}` : ''}${s.stopping ? ', останавливается' : ''}`,
    );
    for (const p of s.progress.slice(0, 12))
      lines.push(
        `${p.finished ? (p.errors ? I.bad : I.ok) : I.run} ${esc(p.server)}: ${p.done}/${p.total}${p.errors ? `, ошибок ${p.errors}` : ''}`,
      );
  } else
    lines.push(
      'Сейчас не выполняется: панель синхронизирует клиентов сама раз в 5 минут и после изменений',
    );
  const kb: Btn[][] = [
    s.syncing
      ? [{ text: 'Остановить', data: cb('so') }]
      : [{ text: 'Синхронизировать', data: cb('sn') }],
    [{ text: 'Обновить', data: cb('sy') }, toSettings],
  ];
  return { text: lines.join('\n'), kb };
}

export function routeView(x: XrayStatus, h: TgHealthView, c: Ctx): Screen {
  const lines = ['<b>Маршрут до Telegram</b>', ''];
  lines.push(
    h.ok === false
      ? `${I.bad} уведомления не доходят${h.failingSince ? ` с ${tgWhen(h.failingSince, c.now)}` : ''}${h.lastError ? `: ${esc(h.lastError)}` : ''}`
      : `${I.ok} уведомления доходят${h.lastOkVia ? `, путь ${esc(h.lastOkVia)}` : ''}`,
  );
  if (!x.configured) lines.push('Выход через свои серверы не настроен');
  else {
    lines.push(
      `xray ${x.running ? 'работает' : 'не запущен'}${x.lastError ? `: ${esc(x.lastError)}` : ''}`,
    );
    for (const e of x.exits.slice(0, 10)) {
      const ch = e.lastCheck;
      lines.push(
        `${ch ? (ch.ok ? I.ok : I.bad) : I.none} ${esc(e.serverName)}${e.primary ? ' (основной)' : ''}${ch?.ok ? `${SEP}${Math.round(ch.ms)}${NB}мс` : ch?.err ? `${SEP}${esc(ch.err)}` : ''}`,
      );
    }
  }
  return { text: lines.join('\n'), kb: [[toSettings]] };
}

export function sessionsView(
  d: {
    failed24: number;
    topIps: { ip: string; n: number }[];
    sessions: { id: string; ip: string; userAgent: string; createdAt: string }[];
  },
  c: Ctx,
): Screen {
  const lines = ['<b>Сессии панели</b>', ''];
  for (const s of d.sessions.slice(0, 15))
    lines.push(
      `${esc(s.ip)}${SEP}${tgWhen(s.createdAt, c.now)}${SEP}${esc(s.userAgent.slice(0, 60))}`,
    );
  if (!d.sessions.length) lines.push('Открытых сессий нет');
  lines.push('', `Неудачных входов за сутки: ${d.failed24}`);
  if (d.topIps.length)
    lines.push(
      `Чаще всего за неделю: ${d.topIps
        .slice(0, 5)
        .map((x) => `<code>${esc(x.ip)}</code> (${x.n})`)
        .join(', ')}`,
    );
  const kb: Btn[][] = [];
  if (d.sessions.length) kb.push([{ text: 'Завершить все сессии', data: cb('sx') }]);
  kb.push([toSettings]);
  return { text: lines.join('\n'), kb };
}
