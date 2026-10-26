import type { CascadesView, ServerDetail, ServiceUpdate, XuiInboundRow } from '@vps/protocol';
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
  cut,
  grid,
  toServer,
} from './common.js';

/** Экраны сервисов сервера, каскадов и смены IP в боте. */

/** Кнопки сервисов в карточке сервера: только тем, что стоят на сервере. */
export function serviceButtons(s: ServerDetail): Btn[] {
  const has = (k: string) => s.services.some((x) => x.kind === k);
  const out: Btn[] = [];
  if (has('xui')) out.push({ text: '3X-UI', data: cb('xu', s.id) });
  if (has('mtproxyl')) out.push({ text: 'MTProxyL', data: cb('mp', s.id) });
  if (has('amnezia')) out.push({ text: 'AWG', data: cb('aw', s.id) });
  if (has('wdtt')) out.push({ text: 'WDTT', data: cb('wd', s.id) });
  if (has('openflux')) out.push({ text: 'OpenFlux', data: cb('of', s.id) });
  return out;
}

function down(s: ServerDetail, kind: string): string | null {
  const x = s.services.find((v) => v.kind === kind);
  if (!x || x.details?.down !== true) return null;
  return typeof x.details.downReason === 'string' ? x.details.downReason : '';
}

function updateLines(list: ServiceUpdate[], kinds: string[]): string[] {
  return list
    .filter((u) => kinds.includes(u.kind))
    .map(
      (u) =>
        `${I.warn} доступна ${esc(u.title)} ${esc(u.latest)}${u.current ? ` (сейчас ${esc(u.current)})` : ''}`,
    );
}

function updateButtons(s: { id: string }, list: ServiceUpdate[], kinds: string[]): Btn[][] {
  return list
    .filter((u) => kinds.includes(u.kind) && UPDATE[u.kind])
    .map((u) => [
      {
        text: `Обновить ${u.title} до ${u.latest}`,
        data: cb('up', s.id, UPDATE[u.kind]?.code ?? ''),
      },
    ]);
}

export function xuiView(
  s: ServerDetail,
  info: { active?: boolean; version?: string; errors?: string[] } | null,
  inbounds: XuiInboundRow[],
  updates: ServiceUpdate[],
): Screen {
  const dn = down(s, 'xui');
  const lines = [
    `<b>${esc(s.name)}</b>${DASH}3X-UI ${dn === null && info?.active !== false ? `${I.ok} работает` : `${I.bad} не работает${dn ? `: ${esc(dn)}` : ''}`}`,
  ];
  if (info?.version) lines.push(`Версия ${esc(info.version)}`);
  lines.push(...updateLines(updates, ['xui', 'xray']));
  const own = inbounds.filter((x) => !x.node);
  lines.push('', `<b>Inbound:</b> ${own.length}, включено ${own.filter((x) => x.enable).length}`);
  for (const x of own.slice(0, 15))
    lines.push(
      `${x.enable ? I.ok : I.none} ${esc(x.remark || x.protocol)}${SEP}${x.port}${SEP}${x.clients}${NB}польз.${x.excluded ? `${SEP}без клиентов панели` : ''}`,
    );
  const kb: Btn[][] = [
    [
      { text: 'Перезапустить 3X-UI', data: cb('rs', s.id, 'x', 'f') },
      { text: 'Перезапустить Xray', data: cb('rx', s.id) },
    ],
    ...updateButtons(s, updates, ['xui', 'xray']),
  ];
  const toggles = own.slice(0, 12).map((x) => ({
    text: `${x.enable ? 'Выключить' : 'Включить'} ${cut(x.remark || String(x.port), 14)}`,
    data: cb('ib', s.id, x.id, x.enable ? 0 : 1),
  }));
  kb.push(...grid(toggles, 2));
  kb.push([{ text: 'Каскады', data: cb('cs', s.id) }]);
  kb.push([toServer(s)]);
  return { text: lines.join('\n'), kb };
}

interface MtStatus {
  installed?: boolean;
  status?: {
    version?: string;
    status?: string;
    port?: number;
    uptime?: number;
    connections?: number;
    unique_ips?: number;
  } | null;
  secrets?: unknown[] | null;
  engine?: string;
  errors?: string[];
}

export function mtView(s: ServerDetail, st: MtStatus | null, updates: ServiceUpdate[]): Screen {
  const dn = down(s, 'mtproxyl');
  const x = st?.status;
  const lines = [
    `<b>${esc(s.name)}</b>${DASH}MTProxyL ${dn === null ? `${I.ok} работает` : `${I.bad} не работает${dn ? `: ${esc(dn)}` : ''}`}`,
  ];
  if (x?.version)
    lines.push(`Версия ${esc(x.version)}${st?.engine ? `, движок ${esc(st.engine)}` : ''}`);
  if (x?.port) lines.push(`Порт ${x.port}`);
  if (x?.connections !== undefined)
    lines.push(
      `Подключений ${x.connections}${x.unique_ips !== undefined ? `, адресов ${x.unique_ips}` : ''}`,
    );
  if (x?.uptime) lines.push(`Работает ${tgSpan(x.uptime * 1000)}`);
  if (st?.secrets) lines.push(`Пользователей ${st.secrets.length}`);
  lines.push(...updateLines(updates, ['mtproxyl', 'mtproxyl-panel']));
  for (const e of (st?.errors ?? []).slice(0, 3)) lines.push(`${I.bad} ${esc(e)}`);
  return {
    text: lines.join('\n'),
    kb: [
      [{ text: 'Перезапустить MTProxyL', data: cb('rs', s.id, 'm', 'f') }],
      ...updateButtons(s, updates, ['mtproxyl', 'mtproxyl-panel']),
      [toServer(s)],
    ],
  };
}

export interface AwgClientRow {
  publicKey: string;
  name: string;
  device?: string;
  disabled: boolean;
  handshake: number;
}
export interface AwgInstanceRow {
  container: string;
  state?: string;
  version?: string;
  port?: number;
  clients?: AwgClientRow[];
  error?: string;
}

const onlineAwg = (c: AwgClientRow, now: number) =>
  c.handshake > 0 && now / 1000 - c.handshake < 180;

export function awgView(
  s: ServerDetail,
  st: { instances?: AwgInstanceRow[] } | null,
  c: Ctx,
): Screen {
  const list = st?.instances ?? [];
  const lines = [`<b>${esc(s.name)}</b>${DASH}AWG`, ''];
  for (const x of list) {
    const users = x.clients ?? [];
    const on = users.filter((u) => onlineAwg(u, c.now)).length;
    lines.push(
      `${x.state === 'running' ? I.ok : I.bad} ${esc(x.container)}${x.version ? ` (${esc(x.version)})` : ''}${x.port ? `${SEP}порт ${x.port}` : ''}`,
      `пользователей ${users.length}, на связи ${on}${users.some((u) => u.disabled) ? `, выключено ${users.filter((u) => u.disabled).length}` : ''}`,
    );
    if (x.error) lines.push(`${I.bad} ${esc(x.error)}`);
  }
  if (!list.length) lines.push('Экземпляров нет');
  const kb: Btn[][] = list
    .slice(0, 8)
    .map((x, i) => [{ text: `Пользователи ${cut(x.container, 22)}`, data: cb('ai', s.id, i, 0) }]);
  kb.push([toServer(s)]);
  return { text: lines.join('\n'), kb };
}

const AWG_PAGE = 12;

export function awgUsersView(
  s: ServerDetail,
  inst: AwgInstanceRow,
  idx: number,
  page: number,
  c: Ctx,
): Screen {
  const users = [...(inst.clients ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const pages = Math.max(1, Math.ceil(users.length / AWG_PAGE));
  const p = Math.min(Math.max(0, page), pages - 1);
  const items = users.slice(p * AWG_PAGE, p * AWG_PAGE + AWG_PAGE);
  const lines = [`<b>${esc(s.name)}</b>${DASH}${esc(inst.container)}`, ''];
  for (const u of items) {
    const st = u.disabled ? I.none : onlineAwg(u, c.now) ? I.ok : I.bad;
    const seen =
      u.handshake > 0 && !onlineAwg(u, c.now)
        ? `${SEP}был ${tgWhen(new Date(u.handshake * 1000).toISOString(), c.now)}`
        : '';
    lines.push(
      `${st} ${esc(u.name || u.publicKey.slice(0, 8))}${u.disabled ? `${SEP}выключен` : seen}`,
    );
  }
  if (!users.length) lines.push('Пользователей нет');
  const kb: Btn[][] = items.map((u) => [
    {
      text: `${u.disabled ? 'Включить' : 'Выключить'} ${cut(u.name || u.publicKey.slice(0, 8), 22)}`,
      data: cb(
        'ae',
        c.ref(JSON.stringify({ sid: s.id, ct: inst.container, pk: u.publicKey, n: u.name })),
        u.disabled ? 1 : 0,
      ),
    },
  ]);
  if (pages > 1)
    kb.push([
      { text: I.prev, data: cb('ai', s.id, idx, (p - 1 + pages) % pages) },
      { text: `${p + 1}/${pages}`, data: cb('ai', s.id, idx, p) },
      { text: I.next, data: cb('ai', s.id, idx, (p + 1) % pages) },
    ]);
  kb.push([{ text: `${I.back} AWG`, data: cb('aw', s.id) }]);
  return { text: lines.join('\n'), kb };
}

export function wdttView(
  s: ServerDetail,
  d: {
    limit?: number;
    passwords?: {
      label: string;
      is_deactivated: boolean;
      device_ids: string[];
      expires_at: number;
    }[];
  } | null,
  c: Ctx,
): Screen {
  const list = d?.passwords ?? [];
  const active = list.filter((p) => !p.is_deactivated);
  const soon = active.filter(
    (p) => p.expires_at && p.expires_at * 1000 - c.now < 30 * 86_400_000,
  ).length;
  const lines = [
    `<b>${esc(s.name)}</b>${DASH}WDTT ${down(s, 'wdtt') === null ? I.ok : I.bad}`,
    '',
    `Паролей ${list.length}${d?.limit ? ` из ${d.limit}` : ''}, активных ${active.length}`,
    `Устройств привязано ${list.reduce((a, p) => a + p.device_ids.length, 0)}`,
  ];
  if (soon) lines.push(`Истекают в течение 30${NB}дней: ${soon}`);
  return { text: lines.join('\n'), kb: [[toServer(s)]] };
}

export function ofView(
  s: ServerDetail,
  d: { core?: string; channels?: { name?: string; enabled?: boolean }[] } | null,
): Screen {
  const ch = d?.channels ?? [];
  const lines = [
    `<b>${esc(s.name)}</b>${DASH}OpenFlux ${down(s, 'openflux') === null ? I.ok : I.bad}`,
    '',
    `${d?.core ? `Ядро ${esc(d.core)}\n` : ''}Каналов ${ch.length}`,
  ];
  return { text: lines.join('\n'), kb: [[toServer(s)]] };
}

const MODE: Record<string, string> = {
  all: 'всё через выход',
  'ru-direct': 'российское напрямую',
  blocked: 'только заблокированное',
};

export function cascadesView(s: ServerDetail, v: CascadesView, c: Ctx): Screen {
  const lines = [`<b>${esc(s.name)}</b>${DASH}каскады`, ''];
  for (const x of v.cascades) {
    const st = x.check
      ? x.check.ok
        ? `${I.ok} ${Math.round(x.check.ms)}${NB}мс`
        : `${I.bad} ${esc(x.check.error ?? 'не отвечает')}`
      : I.none;
    const tg = x.telegram
      ? `${SEP}Telegram: ${x.telegramMain ? 'основной' : 'запасной'}${x.telegramActive ? ', используется' : ''}`
      : '';
    lines.push(
      `${st} ${I.next} ${esc(x.exitServerName)}${SEP}порт ${x.entryPort ?? '?'}${SEP}${MODE[x.mode] ?? x.mode}${tg}`,
    );
    if (x.error) lines.push(`${I.bad} ${esc(x.error)}`);
    if (x.check) lines.push(`<i>проверено ${tgWhen(x.check.at, c.now)}</i>`);
  }
  if (!v.cascades.length) lines.push('Каскадов с этого сервера нет');
  const kb: Btn[][] = v.cascades
    .slice(0, 12)
    .map((x) => [
      { text: `Проверить ${I.next} ${cut(x.exitServerName, 20)}`, data: cb('ck', x.id) },
    ]);
  kb.push([{ text: `${I.back} 3X-UI`, data: cb('xu', s.id) }]);
  return { text: lines.join('\n'), kb };
}

// ---- смена IP ----

export interface IpStep {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail?: string;
}

export function askIp(s: { name: string; host: string }): Screen {
  return {
    text: `<b>${esc(s.name)}</b>${DASH}смена IP\n\nСейчас <code>${esc(s.host)}</code>. Новый адрес${DASH}сообщением. A-запись имени для клиентов нужно сменить у DNS-провайдера заранее.`,
    kb: [[{ text: 'Отмена', data: cb('fx') }]],
  };
}

export function ipCheckView(
  s: { id: string; name: string },
  ip: string,
  steps: IpStep[],
  canSwitch: boolean,
  ref: string,
): Screen {
  const icon = { ok: I.ok, warn: I.warn, fail: I.bad } as const;
  const lines = [`<b>${esc(s.name)}</b>${DASH}смена IP на <code>${esc(ip)}</code>`, ''];
  for (const st of steps)
    lines.push(`${icon[st.level]} ${esc(st.name)}${st.detail ? `: ${esc(st.detail)}` : ''}`);
  const kb: Btn[][] = [];
  if (canSwitch) kb.push([{ text: 'Сменить IP', data: cb('ix', ref) }]);
  kb.push([
    { text: 'Проверить снова', data: cb('iy', ref) },
    { text: 'Отмена', data: cb('fx') },
  ]);
  return { text: lines.join('\n'), kb };
}
