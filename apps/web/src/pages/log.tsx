import { ActionsTable } from '@/components/actions-table';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageTitle } from '@/components/ui/page-title';
import type { ActionRow } from '@/lib/actions';
import { api } from '@/lib/api';
import { useServers } from '@/lib/servers';
import { useQuery } from '@tanstack/react-query';

/** Журнал действий по всем серверам. Без опроса: перечитывается по концу любого действия. */
export function LogPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['actions', 'all'],
    queryFn: () => api<ActionRow[]>('/api/actions'),
  });
  const { data: servers } = useServers();
  const names = new Map((servers ?? []).map((s) => [s.id, s.name]));
  return (
    <>
      <PageTitle>Журнал</PageTitle>
      {error ? (
        <Alert tone="bad">{error.message}</Alert>
      ) : isLoading ? (
        <Card className="p-8 text-muted">Загрузка&hellip;</Card>
      ) : (
        <ActionsTable title="Действия" rows={data ?? []} serverNames={names} />
      )}
    </>
  );
}
