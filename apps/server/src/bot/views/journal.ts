import { type ActionListRow, actionTitle } from '@vps/protocol';
import { esc, tgSpan, tgWhen } from '../../lib/telegram.js';
import { cb } from '../codec.js';
import { type Btn, type Ctx, DASH, I, SEP, type Screen, cut } from './common.js';

/** Журнал действий, действие, подтверждение, код 2FA и ход действия. */

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
      `${I.run} выполняется ${tgSpan(c.now - Date.parse(a.startedAt))}${SEP}с ${tgWhen(a.startedAt, c.now)}`,
    );
  }
  // вывод консоли в Telegram не нужен: у ошибки - последняя строка, целиком - файлом
  const out = a.output.trim();
  if (a.finishedAt && a.exitCode !== 0 && out) {
    const last = out.split('\n').at(-1)?.trim() ?? '';
    if (last) lines.push(`<i>${esc(cut(last, 300))}</i>`);
  }
  const back: Btn =
    d.from === 's' && a.serverId
      ? { text: `${I.back} Журнал сервера`, data: cb('lg', a.serverId, 0) }
      : { text: `${I.back} Журнал`, data: cb('lg', '-', 0) };
  const row: Btn[] = [back];
  if (!a.finishedAt) row.push({ text: 'Обновить', data: cb('ac', a.id, d.from) });
  const kb: Btn[][] = [row];
  if (a.finishedAt && out) kb.unshift([{ text: 'Вывод файлом', data: cb('af', a.id) }]);
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
    text: `${question}\n\n${note ? `${note}\n` : ''}Код двухфакторной аутентификации${DASH}сообщением`,
    kb: [[{ text: 'Отмена', data: cb('cx', token) }]],
  };
}

/** Ход действия: что идёт и сколько, без вывода консоли. */
export function progressText(header: string, startedAt: number, now: number): string {
  const sec = Math.round((now - startedAt) / 1000);
  return `${I.run} ${header}${DASH}выполняется${sec >= 15 ? ` ${tgSpan(now - startedAt)}` : ''}`;
}
