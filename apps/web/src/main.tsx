import { ConfirmProvider } from '@/components/ui/confirm';
import { ApiError, onActionStarted } from '@/lib/api';
import { applyTheme, getTheme } from '@/lib/theme';
import { QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { RouterProvider } from '@tanstack/react-router';
import type { ServerDetail } from '@vps/protocol';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import { router } from './router';

applyTheme(getTheme());

// service worker - только ради установки как приложения; в dev не регистрируем
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined);
  });
}

const queryClient: QueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      // 4xx - ответ панели, повтор его не изменит; повторяем только 5xx и сбои сети
      retry: (n, e) => !(e instanceof ApiError && e.status < 500) && n < 2,
    },
  },
  // сессия истекла или отозвана: без входа - на страницу входа (Gate смотрит на ['me'])
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof ApiError && e.status === 401) queryClient.setQueryData(['me'], null);
    },
  }),
});

// действие запущено: сервер занят сразу (до свежей карточки с activeActions), кнопки всех
// вкладок сервера блокирует serverLock; конец действия перезапрашивает карточку (lib/live.ts)
onActionStarted((serverId, actionId) => {
  queryClient.setQueryData<ServerDetail>(['servers', serverId], (s) =>
    s && !s.activeActions.some((a) => a.id === actionId)
      ? {
          ...s,
          activeActions: [
            ...s.activeActions,
            {
              id: actionId,
              kind: 'started',
              title: 'запущенное действие',
              startedAt: new Date().toISOString(),
            },
          ],
        }
      : s,
  );
  void queryClient.invalidateQueries({ queryKey: ['servers', serverId] });
});

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('root element missing');

createRoot(rootEl).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <RouterProvider router={router} />
      </ConfirmProvider>
    </QueryClientProvider>
  </StrictMode>,
);
