import type { XrayOutbound } from '@vps/protocol';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { panelAddresses } from './panel-host.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import { type XrayManager, spareOff } from './xray.js';
import {
  type XuiCall,
  ensureServiceClient,
  getInbound,
  inboundNode,
  listInbounds,
  realityClientParams,
  streamOf,
  xuiApi,
} from './xui-api.js';
import { xuiToken } from './xui-token.js';

/** Клиент 3X-UI, через которого панель выходит в Telegram (на каждом сервере свой uuid). */
export const EXIT_CLIENT = 'vps-panel';
/** Запасные выходы готовятся раз в 6 часов (и после смены основного). */
const SPARES_EVERY_MS = 6 * 60 * 60_000;

export interface ExitDeps {
  db: Db;
  registry: AgentRegistry;
  box: SecretBox;
  xray: XrayManager;
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void };
  panelUrl: string;
}

/** Ошибка с HTTP-кодом для маршрута настройки. */
const fail = (statusCode: number, message: string) =>
  Object.assign(new Error(message), { statusCode });

/** Reality-inbound-ы VLESS сервера (для выбора в настройках и подбора запасного). */
export async function realityInbounds(api: XuiCall) {
  return (await listInbounds(api))
    .filter((i) => i.protocol === 'vless' && streamOf(i).security === 'reality')
    .map((i) => {
      const network = streamOf(i).network;
      return {
        id: Number(i.id),
        remark: String(i.remark ?? ''),
        port: Number(i.port),
        enable: Boolean(i.enable),
        // выход xray панели умеет только TCP (raw - другое имя tcp)
        tcp: network === 'tcp' || network === 'raw' || network === undefined,
        nodeId: inboundNode(i),
      };
    });
}

/**
 * Выход через inbound сервера: настройки Reality inbound-а и клиент vps-panel (заводится, если
 * его нет, и привязывается к inbound-у). Ничего у других клиентов не меняет.
 */
export async function prepareExit(
  deps: ExitDeps,
  serverId: string,
  inboundId: number,
): Promise<XrayOutbound> {
  const { db, registry, box } = deps;
  const row = (await db.select().from(servers).where(eq(servers.id, serverId)).limit(1))[0];
  if (!row) throw fail(404, 'сервер не найден');
  if (!registry.isOnline(row.id)) throw fail(409, 'сервер не в сети');
  const inv = row.statusCache?.inventory;
  if (!inv?.services.some((s) => s.kind === 'xui')) throw fail(409, 'на сервере нет 3X-UI');
  const api = xuiApi(registry, row.id, await xuiToken(db, box, registry, row.id));

  const inbound = await getInbound(api, inboundId);
  if (!inbound) throw fail(502, '3X-UI не вернула inbound');
  const { publicKey, shortId, sni, fingerprint } = realityClientParams(inbound);
  // клиент vps-panel (3X-UI 3.1+: клиенты - отдельные сущности, как у глобальных клиентов)
  const uuid = await ensureServiceClient(api, {
    email: EXIT_CLIENT,
    inboundId,
    flow: '',
    comment: 'выход VPS Panel в Telegram',
  });

  return {
    serverId: row.id,
    serverName: row.name,
    inboundId,
    inboundRemark: String(inbound.remark ?? ''),
    address: row.host,
    port: Number(inbound.port),
    uuid,
    publicKey,
    shortId,
    sni,
    fingerprint,
    flow: '',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Запасные выходы: на каждом сервере на связи с 3X-UI, кроме сервера панели, сервера основного
 * выхода и выключенных владельцем (`spareOff`), - первый включённый VLESS Reality inbound по TCP
 * (свой, не узла группы).
 * Сервер не на связи сохраняет прежний запасной выход: он мог вернуться к следующей отправке.
 * Основной выход выключен - запасных нет.
 */
export class XraySpares {
  private running: Promise<void> | null = null;

  constructor(private deps: ExitDeps) {}

  start() {
    return schedule(() => void this.sync(), 2 * 60_000, SPARES_EVERY_MS);
  }

  sync(): Promise<void> {
    if (!this.running)
      this.running = this.run().finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async run() {
    const { db, registry, box, xray, log } = this.deps;
    const primary = xray.status().outbound;
    if (!primary) {
      if (await xray.setSpares([], [])) await xray.start();
      return;
    }
    const prev = new Map(
      xray
        .exits()
        .slice(1)
        .map((x) => [x.serverId, x]),
    );
    const panelIps = await panelAddresses(this.deps.panelUrl);
    const rows = await db
      .select({
        id: servers.id,
        name: servers.name,
        host: servers.host,
        cache: servers.statusCache,
      })
      .from(servers);
    const list: XrayOutbound[] = [];
    const errors: { server: string; error: string }[] = [];
    const off = new Set(spareOff(db));
    for (const r of rows) {
      if (r.id === primary.serverId || panelIps.includes(r.host) || off.has(r.id)) continue;
      const inv = r.cache?.inventory;
      if (!inv?.services.some((s) => s.kind === 'xui')) continue;
      if (!registry.isOnline(r.id)) {
        const old = prev.get(r.id);
        if (old) list.push(old);
        continue;
      }
      try {
        const api = xuiApi(registry, r.id, await xuiToken(db, box, registry, r.id));
        const cands = (await realityInbounds(api)).filter((i) => i.enable && i.tcp && !i.nodeId);
        // прежний inbound, если он ещё подходит: клиент vps-panel уже на нём
        const keep = cands.find((i) => i.id === prev.get(r.id)?.inboundId) ?? cands[0];
        if (!keep) {
          errors.push({ server: r.name, error: 'нет включённого inbound VLESS Reality по TCP' });
          continue;
        }
        list.push(await prepareExit(this.deps, r.id, keep.id));
      } catch (e) {
        errors.push({ server: r.name, error: (e as Error).message });
        const old = prev.get(r.id);
        if (old) list.push(old);
      }
    }
    const changed = await xray.setSpares(list, errors);
    log.info(
      { spares: list.map((x) => x.serverName), errors: errors.length },
      'xray: запасные выходы',
    );
    if (changed) {
      await xray.start();
      await new Promise((r) => setTimeout(r, 1_500));
      await xray.checkAll();
    }
  }
}

/**
 * Inbound сервера удалили, выключили или поменяли (порт) из панели. Основной выход хранит
 * снимок параметров inbound-а, поэтому сам за ним не следует: если изменился его inbound -
 * снимок собирается заново; если inbound-а больше нет (удалён, выключен) - основной выход
 * переходит на другой подходящий inbound этого сервера, иначе на запасной выход (лучше тот, чья
 * проверка прошла), иначе снимается. Запасные пересобираются сразу, не через 6 часов.
 * Возвращает строки для журнала действия.
 */
export async function exitsAfterInboundChange(
  deps: ExitDeps,
  spares: Pick<XraySpares, 'sync'>,
  serverId: string,
  inboundId: number,
  gone: boolean,
): Promise<string[]> {
  const { xray, log } = deps;
  const notes: string[] = [];
  const [primary, ...rest] = xray.exits();
  if (primary && primary.serverId === serverId && primary.inboundId === inboundId) {
    try {
      let next: XrayOutbound | null = null;
      if (!gone) {
        next = await prepareExit(deps, serverId, inboundId);
        notes.push('Основной выход в Telegram обновлён под новые настройки inbound');
      } else {
        const api = xuiApi(
          deps.registry,
          serverId,
          await xuiToken(deps.db, deps.box, deps.registry, serverId),
        );
        const cand = (await realityInbounds(api)).find(
          (i) => i.id !== inboundId && i.enable && i.tcp && !i.nodeId,
        );
        if (cand) {
          next = await prepareExit(deps, serverId, cand.id);
          notes.push(
            `Основной выход в Telegram перенесён на inbound \u00ab${cand.remark || `#${cand.id}`}\u00bb этого сервера`,
          );
        } else {
          next = bestSpare(xray, rest);
          notes.push(movedNote(next, 'подходящего inbound нет'));
        }
      }
      await setPrimary(xray, next);
    } catch (e) {
      notes.push(`Основной выход в Telegram не обновлён: ${(e as Error).message}`);
    }
  }
  void spares.sync().catch((e: Error) => log.warn({ err: e.message }, 'xray: запасные'));
  return notes;
}

/** Сервер удалён из панели: основной выход через него - на запасной, запасные - заново. */
export async function exitsAfterServerRemoved(
  deps: ExitDeps,
  spares: Pick<XraySpares, 'sync'>,
  serverId: string,
): Promise<void> {
  const { xray, log } = deps;
  const [primary, ...rest] = xray.exits();
  if (primary?.serverId === serverId) {
    const next = bestSpare(
      xray,
      rest.filter((x) => x.serverId !== serverId),
    );
    await setPrimary(xray, next).catch((e: Error) => log.warn({ err: e.message }, 'xray'));
    log.info({ serverId }, movedNote(next, 'сервер удалён из панели'));
  }
  await spares.sync().catch((e: Error) => log.warn({ err: e.message }, 'xray: запасные'));
}

/** Запасной выход, чья проверка прошла, иначе первый. */
function bestSpare(xray: Pick<XrayManager, 'status'>, spares: XrayOutbound[]): XrayOutbound | null {
  const views = xray.status().exits.slice(1);
  const ok = spares.findIndex((x) =>
    views.some((v) => v.serverId === x.serverId && v.lastCheck?.ok),
  );
  return spares[ok >= 0 ? ok : 0] ?? null;
}

function movedNote(next: XrayOutbound | null, why: string): string {
  return next
    ? `Основной выход в Telegram перенесён на запасной: ${next.serverName}`
    : `Основной выход в Telegram снят: ${why}, его нужно выбрать в \u00abНастройках\u00bb`;
}

async function setPrimary(
  xray: Pick<XrayManager, 'save' | 'start' | 'stop'>,
  next: XrayOutbound | null,
) {
  await xray.save(next);
  if (next) await xray.start();
  else await xray.stop();
}

/** Выходы в Telegram для маршрутов inbound-ов 3X-UI. */
export interface InboundExitHooks {
  xray: Pick<XrayManager, 'exits'>;
  exitsAfter: (serverId: string, inboundId: number, gone: boolean) => Promise<string[]>;
  syncSpares: () => void;
}

/** Через этот inbound идёт выход в Telegram: основной, запасной или нет. */
export function telegramExitOf(
  exits: readonly XrayOutbound[],
  serverId: string,
  inboundId: number,
): 'primary' | 'spare' | null {
  const i = exits.findIndex((x) => x.serverId === serverId && x.inboundId === inboundId);
  return i < 0 ? null : i === 0 ? 'primary' : 'spare';
}
