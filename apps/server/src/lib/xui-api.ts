import type { AgentRegistry } from '../agents/registry.js';

/** Ответ REST 3X-UI через агента (xui.api): HTTP-код и тело. */
export interface ApiResult {
  status: number;
  data?: unknown;
  text?: string;
}
/** Конверт ответов 3X-UI: {success, msg, obj}. */
export interface XuiEnvelope {
  success?: boolean;
  msg?: string;
  obj?: unknown;
}
export type XuiCall = (method: 'GET' | 'POST', path: string, body?: unknown) => Promise<ApiResult>;

/** Вызов REST 3X-UI сервера через агента: `/panel/api/<path>` с токеном панели. */
export function xuiApi(registry: AgentRegistry, serverId: string, token: string): XuiCall {
  return async (method, path, body) =>
    (await registry.request(
      serverId,
      'xui.api',
      { token, method, path, body: body ?? null },
      { timeoutMs: 60_000 },
    )) as ApiResult;
}

/** settings и streamSettings 3X-UI отдаёт то строкой JSON (старые версии), то объектом. */
export function parseJson(v: unknown): Record<string, unknown> {
  if (typeof v === 'string') {
    try {
      return JSON.parse(v) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return (v as Record<string, unknown>) ?? {};
}

/** Inbound 3X-UI, как его отдаёт inbounds/list и inbounds/get. */
export type RawInbound = Record<string, unknown>;

/** Узел группы 3X-UI, которому принадлежит inbound; 0 - этот сервер. */
export const inboundNode = (i: RawInbound) => Number(i.nodeId ?? i.node_id ?? 0);

export const streamOf = (i: RawInbound) => parseJson(i.streamSettings);

/**
 * Свои VLESS-inbound-ы сервера: без inbound-ов других узлов группы 3X-UI - туда глобальные
 * клиенты не заводятся.
 */
export function ownVlessInbounds(list: RawInbound[]): RawInbound[] {
  return list.filter((i) => i.protocol === 'vless' && !inboundNode(i));
}

export async function listInbounds(api: XuiCall): Promise<RawInbound[]> {
  return (unwrap(await api('GET', 'inbounds/list'), 'inbounds/list') as RawInbound[] | null) ?? [];
}

export async function getInbound(api: XuiCall, id: number): Promise<RawInbound | null> {
  return unwrap(await api('GET', `inbounds/get/${id}`), 'inbounds/get') as RawInbound | null;
}

/** Нет API-токена 3X-UI: код no-token - вкладка предлагает его выпустить. */
export const noXuiToken = () =>
  Object.assign(new Error('нет API-токена 3X-UI: его нужно выпустить на вкладке 3X-UI'), {
    statusCode: 409,
    code: 'no-token',
  });

/** obj ответа или исключение с текстом 3X-UI. */
export function unwrap(r: ApiResult, what: string): unknown {
  const env = r.data as XuiEnvelope | undefined;
  if (r.status !== 200 || !env?.success)
    throw Object.assign(new Error(`3X-UI (${what}): ${env?.msg ?? r.status}`), { statusCode: 502 });
  return env.obj;
}

/** Клиент v3 из `clients/get/:email`: в ответе {client, inboundIds}, UUID - в uuid (или id). */
export interface XuiClient {
  uuid: string;
  email: string;
  subId: string;
  enable: boolean;
  flow: string;
  inboundIds: number[];
}

export function readClient(obj: unknown): XuiClient | null {
  if (!obj || typeof obj !== 'object') return null;
  const o = obj as Record<string, unknown>;
  const c = (typeof o.client === 'object' && o.client ? o.client : o) as Record<string, unknown>;
  const uuid = String(c.uuid ?? c.id ?? '');
  if (!uuid) return null;
  return {
    uuid,
    email: String(c.email ?? ''),
    subId: String(c.subId ?? ''),
    enable: c.enable !== false,
    flow: String(c.flow ?? ''),
    inboundIds: ((o.inboundIds ?? c.inboundIds) as number[] | undefined) ?? [],
  };
}
