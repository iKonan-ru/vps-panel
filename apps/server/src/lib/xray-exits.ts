import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AgentRegistry } from '../agents/registry.js';
import type { StatusCache } from '../agents/state.js';
import type { Db } from '../db/index.js';
import { servers } from '../db/schema.js';
import { panelAddresses } from './panel-host.js';
import { schedule } from './schedule.js';
import type { SecretBox } from './secret-box.js';
import type { XrayManager, XrayOutbound } from './xray.js';
import {
  type XuiCall,
  type XuiEnvelope,
  parseJson,
  readClient,
  unwrap,
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
  const list =
    (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as Record<string, unknown>[]) ?? [];
  return list
    .filter((i) => {
      const ss = parseJson(i.streamSettings);
      return i.protocol === 'vless' && ss.security === 'reality';
    })
    .map((i) => {
      const ss = parseJson(i.streamSettings);
      return {
        id: Number(i.id),
        remark: String(i.remark ?? ''),
        port: Number(i.port),
        enable: Boolean(i.enable),
        // выход xray панели умеет только TCP (raw - новое имя того же)
        tcp: ss.network === 'tcp' || ss.network === 'raw' || ss.network === undefined,
        nodeId: Number(i.nodeId ?? i.node_id ?? 0),
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
  if (!row) throw fail(404, 'Сервер не найден');
  if (!registry.isOnline(row.id)) throw fail(409, 'Агент не подключён');
  const inv = (row.statusCache as StatusCache | null)?.inventory;
  if (!inv?.services.some((s) => s.kind === 'xui'))
    throw fail(409, 'На этом сервере агент не нашёл 3X-UI');
  const api = xuiApi(registry, row.id, await xuiToken(db, box, registry, row.id));

  const inbound = unwrap(await api('GET', `inbounds/get/${inboundId}`), 'inbounds/get') as Record<
    string,
    unknown
  > | null;
  if (!inbound) throw fail(502, '3X-UI не отдал inbound');
  const ss = parseJson(inbound.streamSettings);
  const rs = parseJson(ss.realitySettings);
  const rsSettings = parseJson(rs.settings);
  if (inbound.protocol !== 'vless' || ss.security !== 'reality')
    throw fail(409, 'Нужен inbound VLESS с security = reality');
  const publicKey = String(rsSettings.publicKey ?? '');
  const shortId = String((rs.shortIds as string[] | undefined)?.[0] ?? '');
  const sni = String((rs.serverNames as string[] | undefined)?.[0] ?? '');
  if (!publicKey || !sni)
    throw fail(409, 'У inbound-а нет publicKey или serverNames в настройках Reality');

  // клиент vps-panel (3X-UI 3.1+: клиенты - отдельные сущности, как у глобальных клиентов)
  const got = await api('GET', `clients/get/${EXIT_CLIENT}`);
  if (got.status === 404) throw fail(409, '3X-UI старше 3.1 (нет API клиентов): обнови 3X-UI');
  let client = (got.data as XuiEnvelope | undefined)?.success
    ? readClient((got.data as XuiEnvelope).obj)
    : null;
  if (!client) {
    unwrap(
      await api('POST', 'clients/add', {
        client: {
          email: EXIT_CLIENT,
          enable: true,
          limitIp: 0,
          totalGB: 0,
          expiryTime: 0,
          subId: randomUUID().replace(/-/g, '').slice(0, 16),
          reset: 0,
          flow: '',
          comment: 'выход VPS Panel в Telegram',
        },
        inboundIds: [inboundId],
      }),
      'clients/add',
    );
    client = readClient(unwrap(await api('GET', `clients/get/${EXIT_CLIENT}`), 'clients/get'));
  } else if (!client.inboundIds.includes(inboundId)) {
    unwrap(
      await api('POST', `clients/${EXIT_CLIENT}/attach`, { inboundIds: [inboundId] }),
      'attach',
    );
  }
  const uuid = client?.uuid ?? '';
  if (!uuid) throw fail(502, '3X-UI не вернул uuid клиента vps-panel');

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
    fingerprint: String(rsSettings.fingerprint || 'chrome'),
    flow: '',
    updatedAt: new Date().toISOString(),
  };
}

/**
 * Запасные выходы: на каждом сервере на связи с 3X-UI, кроме сервера панели и сервера
 * основного выхода, - первый включённый VLESS Reality inbound по TCP (свой, не узла группы).
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
    for (const r of rows) {
      if (r.id === primary.serverId || panelIps.includes(r.host)) continue;
      const inv = (r.cache as StatusCache | null)?.inventory;
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
          errors.push({ server: r.name, error: 'нет включённого VLESS Reality inbound-а по TCP' });
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
