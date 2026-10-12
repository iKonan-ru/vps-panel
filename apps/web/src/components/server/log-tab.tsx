import { ActionsTable } from '@/components/actions-table';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { actions } from '@/lib/actions';
import { useQuery } from '@tanstack/react-query';

/**
 * Вкладка "Журнал": действия панели на этом сервере. Без опроса: список сбрасывается по
 * событию конца любого действия (lib/live.ts).
 */
export function LogTab({ serverId }: { serverId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['actions', serverId],
    queryFn: () => actions.log(serverId),
  });
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (isLoading) return <Card className="p-8 text-muted">Загрузка&hellip;</Card>;
  return <ActionsTable title="Журнал действий" rows={data ?? []} />;
}
