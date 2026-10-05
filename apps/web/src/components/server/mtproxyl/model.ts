import { api } from '@/lib/api';

/** MTProxyL сервера: ответы агента и вызовы API панели. */

interface MtStatus {
  installed: boolean;
  status: {
    version: string;
    mode: string;
    status: string;
    port: number;
    domain: string;
    uptime: number;
    connections: number;
    unique_ips: number;
    traffic_in: number;
    traffic_out: number;
    traffic_total: number;
  } | null;
  traffic: {
    users?: MtTraffic[];
  } | null;
  secrets: MtUser[] | null;
  panel: string;
  /** Версия движка telemt; "" - неизвестна (status.version - версия самого MTProxyL). */
  engine?: string;
  errors: string[];
}

export interface MtUser {
  label: string;
  secret: string;
  created: number;
  enabled: boolean;
  max_conns: number;
  max_ips: number;
  quota_bytes: number;
  expires: string;
  ad_tag: string;
  total_bytes: number;
  ip_history: unknown[];
}

export type MtTraffic = { user: string; total: number; connections: number; unique_ips: number };

export const mtApi = {
  status: (id: string) => api<MtStatus>(`/api/servers/${id}/mtproxyl`),
  exec: (id: string, op: string, args: Record<string, string> = {}) =>
    api<{ actionId?: string; ok?: boolean; output?: string }>(`/api/servers/${id}/mtproxyl/exec`, {
      method: 'POST',
      json: { op, args },
    }),
};
