import type { Service, StdCell, StdItem, StdKey } from '@vps/protocol';
import type { ServiceUpdate } from './service-updates.js';

/**
 * Эталон сервисов: на каждом сервере (сервер панели - если на нём заводятся клиенты) - 3X-UI, MTProxyL, AWG 3.1 и 2.0,
 * WDTT, OpenFlux, прокси для браузера. install - команда каталога, которой недостающее ставится.
 */

export const STANDARD: StdItem[] = [
  { key: 'xui', title: '3X-UI', install: 'xui' },
  { key: 'mtproxyl', title: 'MTProxyL', install: 'mtproxyl' },
  { key: 'awg-3.1', title: 'AWG 3.1', install: 'awg', installHint: 'версия 3.1' },
  {
    key: 'awg-2.0',
    title: 'AWG 2.0',
    install: 'awg',
    installHint: 'версия 2.0, экземпляр дополнительный',
  },
  { key: 'wdtt', title: 'WDTT', install: 'wdtt' },
  { key: 'openflux', title: 'OpenFlux', install: 'openflux' },
  { key: 'naive', title: 'Браузер', install: 'naive' },
];

/** Экземпляр AWG по последнему опросу агента (awg.status). */
export interface AwgInstanceBrief {
  container: string;
  version: string;
  state: string;
}

const num = (v: unknown) => (typeof v === 'number' ? v : 0);

/**
 * Клетки матрицы для одного сервера. awg - экземпляры AWG (null - не опрашивались), updates -
 * доступные обновления сервисов сервера.
 */
export function standardCells(o: {
  services: Service[];
  awg: AwgInstanceBrief[] | null;
  updates: ServiceUpdate[];
}): Record<StdKey, StdCell> {
  const svc = (kind: string) => o.services.find((s) => s.kind === kind);
  const upd = (kinds: string[]) => o.updates.filter((u) => kinds.includes(u.kind));
  const updHint = (list: ServiceUpdate[]) =>
    list.map((u) => `${u.title}: ${u.current} -> ${u.latest}`).join('; ');

  const xui = svc('xui');
  let xuiCell: StdCell = { state: 'missing', text: 'нет' };
  if (xui) {
    // агент отдаёт список включённых внешних inbound-ов (detect.go), без них - null
    const list = xui.details?.inbounds;
    const own = Array.isArray(list) ? list.length : 0;
    const nodes = num(xui.details?.remoteNodes);
    const u = upd(['xui', 'xray']);
    const notes = [
      ...(own === 0 ? ['нет своих inbound-ов'] : []),
      ...(nodes > 0 ? [`узлов группы 3X-UI: ${nodes}`] : []),
      ...(u.length ? ['есть обновление'] : []),
    ];
    xuiCell = {
      state: notes.length ? 'warn' : 'ok',
      text: [xui.version ?? '?', `inbound-ов ${own}`].join(', '),
      ...(notes.length ? { hint: [notes.join(', '), updHint(u)].filter(Boolean).join('. ') } : {}),
    };
  }

  const mt = svc('mtproxyl');
  let mtCell: StdCell = { state: 'missing', text: 'нет' };
  if (mt) {
    const u = upd(['mtproxyl', 'mtproxyl-panel']);
    mtCell = {
      state: u.length ? 'warn' : 'ok',
      text: `${mt.version ?? '?'}${mt.panelUrl ? ', с панелью' : ''}`,
      ...(u.length ? { hint: `есть обновления. ${updHint(u)}` } : {}),
    };
  }

  // AWG: версия - по живому опросу; контейнеры без него видны только по инвентарю
  const awgCell = (major: string): StdCell => {
    const containers = o.services.filter((s) => s.kind === 'amnezia');
    if (!o.awg)
      return containers.length
        ? { state: 'unknown', text: 'версия неизвестна', hint: 'агент не ответил на awg.status' }
        : { state: 'missing', text: 'нет' };
    const hit = o.awg.filter((i) => i.version.startsWith(major));
    if (!hit.length) return { state: 'missing', text: 'нет' };
    const stopped = hit.filter((i) => i.state !== 'running');
    return {
      state: stopped.length === hit.length ? 'warn' : 'ok',
      text: hit.map((i) => i.container).join(', '),
      ...(stopped.length
        ? { hint: `не запущен: ${stopped.map((i) => i.container).join(', ')}` }
        : {}),
    };
  };

  // OpenFlux: каналы и автообновление ядра по инвентарю (services/openflux.go); упал канал - warn
  const of = svc('openflux');
  let ofCell: StdCell = { state: 'missing', text: 'нет' };
  if (of) {
    const chans = Array.isArray(of.details?.channels) ? of.details.channels.length : 0;
    const notes = [
      ...(of.details?.down === true ? [String(of.details.downReason ?? 'канал не работает')] : []),
      ...(of.details?.autoupdate === false ? ['автообновление ядра выключено'] : []),
    ];
    ofCell = {
      state: notes.length ? 'warn' : 'ok',
      text: [of.version ?? '?', `каналов ${chans}`].join(', '),
      ...(notes.length ? { hint: notes.join(', ') } : {}),
    };
  }

  // прокси для браузера: имя - в деталях инвентаря, служба упала - warn
  const nv = svc('naive');
  const nvCell: StdCell = !nv
    ? { state: 'missing', text: 'нет' }
    : nv.details?.down === true
      ? {
          state: 'warn',
          text: String(nv.details?.domain ?? 'есть'),
          hint: String(nv.details.downReason ?? 'служба не работает'),
        }
      : { state: 'ok', text: String(nv.details?.domain ?? 'есть') };

  return {
    xui: xuiCell,
    mtproxyl: mtCell,
    'awg-3.1': awgCell('3'),
    'awg-2.0': awgCell('2'),
    wdtt: svc('wdtt') ? { state: 'ok', text: 'есть' } : { state: 'missing', text: 'нет' },
    openflux: ofCell,
    naive: nvCell,
  };
}
