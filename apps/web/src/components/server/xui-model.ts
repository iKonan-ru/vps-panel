import { api } from '@/lib/api';
import type { XuiInfo, XuiServerStatus } from '@vps/protocol';

/** Компоненты блока "Версии": сама панель 3X-UI и Xray внутри неё. */
export type XuiVersionKind = 'xui' | 'xray';

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
