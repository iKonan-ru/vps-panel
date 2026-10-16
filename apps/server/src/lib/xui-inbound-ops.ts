import type { Listener } from '@vps/protocol';
import { type XuiCall, listInbounds, unwrap } from './xui-api.js';
import {
  type Fingerprint,
  KIND_TITLE,
  type NewInboundKind,
  type RealityScanRow,
  buildInbound,
  pickTargets,
  portBusy,
} from './xui-new-inbound.js';

/**
 * Проверки Xray после добавления. 3X-UI отвечает успехом сразу и ещё ~10 с показывает Xray
 * работающим, а на занятом порту он падает при перезапуске, который 3X-UI делает позже (на
 * 3.10.2 - около 15 с), поэтому смотрим ~28 с.
 */
export const XRAY_CHECKS_MS = [4_000, 6_000, 6_000, 6_000, 6_000];

/** Состояние Xray по server/status 3X-UI. */
export async function xrayState(api: XuiCall): Promise<{ state: string; error: string }> {
  const obj = unwrap(await api('GET', 'server/status'), 'server/status') as {
    xray?: { state?: string; errorMsg?: string };
  } | null;
  return { state: String(obj?.xray?.state ?? 'unknown'), error: String(obj?.xray?.errorMsg ?? '') };
}

/** Xray после добавления: несколько проверок подряд; не работает - причина, иначе null. */
export async function watchXray(api: XuiCall, waits = XRAY_CHECKS_MS): Promise<string | null> {
  for (const ms of waits) {
    await new Promise((r) => setTimeout(r, ms));
    try {
      const st = await xrayState(api);
      if (st.state !== 'running') return st.error || st.state;
    } catch (e) {
      return (e as Error).message;
    }
  }
  return null;
}

/** Лучшая цель Reality по скану 3X-UI с самого сервера (имена YouTube отброшены). */
export async function bestRealityTarget(api: XuiCall) {
  const rows = unwrap(await api('POST', 'server/scanRealityTargets'), 'server/scanRealityTargets');
  return pickTargets(Array.isArray(rows) ? (rows as RealityScanRow[]) : [])[0] ?? null;
}

export interface NewItem {
  kind: NewInboundKind;
  port: number;
  remark: string;
}

/**
 * Добавление inbound-ов VLESS Reality по одному: порт не занят ни inbound-ом, ни процессом
 * (inbound на занятом порту останавливает весь Xray), после добавления Xray проверяется ~28 с;
 * остановился - inbound удаляется и ошибка. Возвращает подписи добавленных; при ошибке
 * добавленные до неё остаются (их видно в created исключения).
 */
export async function addInbounds(
  api: XuiCall,
  args: {
    items: NewItem[];
    target: string;
    serverNames: string[];
    fingerprint: Fingerprint;
    listeners: () => Listener[];
    say: (line: string) => void;
    checks?: number[];
  },
): Promise<string[]> {
  const created: string[] = [];
  try {
    const st = await xrayState(api);
    if (st.state !== 'running')
      throw new Error(
        `Xray не работает (${st.state}${st.error ? `: ${st.error}` : ''}): сначала нужно его запустить`,
      );
    for (const item of args.items) {
      const title = `${KIND_TITLE[item.kind]} \u00ab${item.remark}\u00bb, порт ${item.port}`;
      args.say(`${title}: проверка порта`);
      const busy = portBusy(item.port, await listInbounds(api), args.listeners());
      if (busy) throw new Error(busy);
      const inbound = buildInbound({
        kind: item.kind,
        port: item.port,
        remark: item.remark,
        target: args.target,
        serverNames: args.serverNames,
        fingerprint: args.fingerprint,
      });
      const obj = unwrap(await api('POST', 'inbounds/add', inbound), 'inbounds/add') as {
        id?: number;
      } | null;
      const iid = Number(obj?.id ?? 0);
      args.say(`${title}: добавлен, проверка Xray`);
      const bad = await watchXray(api, args.checks);
      if (bad) {
        if (iid) await api('POST', `inbounds/del/${iid}`).catch(() => undefined);
        throw new Error(`Xray остановился после добавления, inbound удалён: ${bad}`);
      }
      args.say(`${title}: Xray работает`);
      created.push(title);
    }
    return created;
  } catch (e) {
    throw Object.assign(e as Error, { created });
  }
}
