import { useQuery } from '@tanstack/react-query';
import { ApiError, api } from './api';

export interface Me {
  login: string;
  /** Имя в интерфейсе; пусто - показывается логин. */
  displayName: string;
  expiresAt: string;
}

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/api/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
}

export function useSetupStatus() {
  return useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api<{ setupDone: boolean }>('/api/setup/status'),
    staleTime: Number.POSITIVE_INFINITY,
  });
}
