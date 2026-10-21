import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import type { ReactNode } from 'react';

/** Карточка-заглушка вместо содержимого. */
export function Placeholder({ children }: { children: ReactNode }) {
  return <Card className="p-8 text-[13px] text-muted">{children}</Card>;
}

/** Данных ещё нет: сервер не в сети (offline), ошибка загрузки или загрузка. */
export function LoadState({ offline, error }: { offline?: boolean; error?: Error | null }) {
  if (offline) return <Placeholder>Сервер не в сети</Placeholder>;
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  return (
    <Placeholder>
      <span className="animate-pulse">Загрузка&hellip;</span>
    </Placeholder>
  );
}
