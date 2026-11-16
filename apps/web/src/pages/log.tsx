import { ActionsTable } from '@/components/actions-table';
import { ServerLogFeed } from '@/components/server-log-feed';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { PageTitle } from '@/components/ui/page-title';
import { Tabs } from '@/components/ui/tabs';
import type { ActionRow } from '@/lib/actions';
import { api } from '@/lib/api';
import { useServers } from '@/lib/servers';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * Журнал: лента журнала серверов и журнал действий по всем серверам. Действия - без опроса:
 * перечитываются по концу любого действия.
 */
export function LogPage() {
  const [tab, setTab] = useState<'servers' | 'actions'>('servers');
  return (
    <>
      <PageTitle>Журнал</PageTitle>
      <Tabs
        items={[
          { id: 'servers', title: 'Серверы' },
          { id: 'actions', title: 'Действия' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'servers' ? <ServerLogFeed /> : <AllActions />}
    </>
  );
}

function AllActions() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['actions', 'all'],
    queryFn: () => api<ActionRow[]>('/api/actions'),
  });
  const { data: servers } = useServers();
  const names = new Map((servers ?? []).map((s) => [s.id, s.name]));
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (isLoading) return <Card className="p-8 text-muted">Загрузка&hellip;</Card>;
  return <ActionsTable title="Действия" rows={data ?? []} serverNames={names} />;
}
