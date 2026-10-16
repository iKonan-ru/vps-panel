import { api } from '@/lib/api';

export interface Component {
  id: string;
  title: string;
  paths?: string[];
  containers?: string[];
  sizeBytes: number;
}

export interface Backup {
  id: string;
  serverId: string | null;
  serverName: string;
  hostname: string;
  createdAt: string;
  size: number;
  sha256: string;
  manifest: { components?: Component[] };
}

export const backupsApi = {
  list: () => api<Backup[]>('/api/backups'),
  components: (serverId: string) => api<Component[]>(`/api/servers/${serverId}/backups/components`),
  create: (serverId: string, components: string[]) =>
    api<{ actionId: string; backupId: string }>(`/api/servers/${serverId}/backups`, {
      method: 'POST',
      json: { components },
    }),
  remove: (id: string) => api<{ ok: boolean }>(`/api/backups/${id}`, { method: 'DELETE' }),
  restore: (id: string, serverId: string, components: string[]) =>
    api<{ actionId: string }>(`/api/backups/${id}/restore`, {
      method: 'POST',
      json: { serverId, components },
    }),
};
