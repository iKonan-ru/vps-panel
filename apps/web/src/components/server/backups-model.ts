import { api } from '@/lib/api';
import type { BackupComponent, BackupInfo } from '@vps/protocol';

export const backupsApi = {
  list: () => api<BackupInfo[]>('/api/backups'),
  components: (serverId: string) =>
    api<BackupComponent[]>(`/api/servers/${serverId}/backups/components`),
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
