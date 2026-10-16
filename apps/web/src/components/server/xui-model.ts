import { api } from '@/lib/api';

/** Компоненты блока "Версии": сама панель 3X-UI и Xray внутри неё. */
export type XuiVersionKind = 'xui' | 'xray';

export interface XuiInfo {
  installed: boolean;
  active: boolean;
  enabled: boolean;
  version: string;
  db: string;
  panelPort: number;
  listen: string;
  basePath: string;
  https: boolean;
  certFile: string;
  twoFactor: boolean;
  subEnabled: boolean;
  subPort: number;
  inbounds: number;
  log: string;
  errors: string[];
}

/** server/status 3X-UI (поле obj ответа REST API). */
export interface XuiServerStatus {
  cpu?: number;
  mem?: { current: number; total: number };
  uptime?: number;
  xray?: { state: string; version: string; errorMsg?: string };
  appStats?: { threads: number; mem: number; uptime: number };
}

export const xuiApi = {
  info: (id: string) => api<XuiInfo>(`/api/servers/${id}/xui`),
  set: (id: string, body: Record<string, unknown>) =>
    api<{ actionId: string }>(`/api/servers/${id}/xui/set`, { method: 'POST', json: body }),
  service: (id: string, action: string) =>
    api<{ actionId: string }>(`/api/servers/${id}/xui/service`, {
      method: 'POST',
      json: { action },
    }),
  token: (id: string) => api<{ ok: boolean }>(`/api/servers/${id}/xui/token`, { method: 'POST' }),
  status: (id: string) => api<XuiServerStatus>(`/api/servers/${id}/xui/status`),
};
