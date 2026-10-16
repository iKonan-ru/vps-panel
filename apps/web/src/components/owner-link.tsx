import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { GOwner, GService } from '@vps/protocol';
import { UserRound } from 'lucide-react';
import { useCallback } from 'react';

/** Чьи записи в сервисах сервера: owner(сервис, ключ) - клиент панели или undefined (вручную). */
export function useOwners(serverId: string) {
  const { data } = useQuery({
    queryKey: ['gclient-owners', serverId],
    queryFn: () => api<GOwner[]>(`/api/servers/${serverId}/gclient-owners`),
    staleTime: 30_000,
  });
  return useCallback(
    (service: GService, key: string | undefined) =>
      key ? data?.find((o) => o.service === service && o.key === key) : undefined,
    [data],
  );
}

/** Ключи паролей WDTT, как у сервера: 16 hex от sha256 - сам пароль в список не уходит. */
export function useWdttKeys(passwords: string[]) {
  const { data } = useQuery({
    queryKey: ['wdtt-keys', passwords],
    queryFn: async () => {
      const out = new Map<string, string>();
      for (const p of passwords) {
        const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p));
        const hex = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
        out.set(p, hex.slice(0, 16));
      }
      return out;
    },
    staleTime: Number.POSITIVE_INFINITY,
  });
  return data;
}

/** Ссылка на карточку клиента панели: имя и устройство (если запись - на устройство). */
export function OwnerLink({ owner, device = true }: { owner: GOwner; device?: boolean }) {
  return (
    <Link
      to="/clients/$id"
      params={{ id: owner.clientId }}
      title="Клиент панели: открыть карточку"
      className="inline-flex min-w-0 items-center gap-1 text-xs text-accent hover:underline"
      onClick={(e) => e.stopPropagation()}
    >
      <UserRound className="size-3.5 shrink-0" />
      <span className="truncate">
        {owner.client}
        {device && owner.device && <span className="text-muted"> ({owner.device})</span>}
      </span>
    </Link>
  );
}
