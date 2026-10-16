import { Alert } from '@/components/ui/alert';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { TgHealthView } from '@vps/protocol';

function useTgHealth() {
  return useQuery({
    queryKey: ['tg-health'],
    queryFn: () => api<TgHealthView>('/api/notify/telegram/health'),
    refetchInterval: 60_000,
  });
}

/** " уже 15 мин" - сколько не доходит; только что - пусто. */
export function failingFor(since: string | null): string {
  const a = ago(since);
  return a && a !== 'только что' ? ` уже ${a.replace(' назад', '')}` : '';
}

/**
 * Плашка над страницей, пока уведомления в Telegram не доходят: с какого времени, почему,
 * сколько отложено; ведёт в настройки (тест, выход через xray).
 */
export function TelegramBanner() {
  const { data } = useTgHealth();
  if (!data?.configured || data.ok !== false) return null;
  return (
    <Alert tone="bad">
      {`Уведомления в Telegram не доходят${failingFor(data.failingSince)}`}
      {data.pending > 0 ? `, отложено сообщений: ${data.pending}` : ''}
      {'. '}
      {data.lastError && <span className="break-words">{data.lastError}. </span>}
      <Link to="/settings" className="underline">
        Настройки
      </Link>
    </Alert>
  );
}
