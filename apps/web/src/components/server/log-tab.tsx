import { ActionsTable } from '@/components/actions-table';
import { ServerLogFeed } from '@/components/server-log-feed';
import { Alert } from '@/components/ui/alert';
import { Card } from '@/components/ui/card';
import { Tabs } from '@/components/ui/tabs';
import { actions } from '@/lib/actions';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';

/** Журнал сервера: лента журнала серверов по этому серверу и журнал его действий. */
export function LogTab({ serverId }: { serverId: string }) {
  const [tab, setTab] = useState<'events' | 'actions'>('events');
  return (
    <>
      <Tabs
        items={[
          { id: 'events', title: 'События' },
          { id: 'actions', title: 'Действия' },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === 'events' ? (
        <ServerLogFeed serverId={serverId} />
      ) : (
        <ServerActions serverId={serverId} />
      )}
    </>
  );
}

/** Журнал действий сервера. Без опроса: перечитывается по концу любого действия. */
function ServerActions({ serverId }: { serverId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['actions', serverId],
    queryFn: () => actions.log(serverId),
  });
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (isLoading) return <Card className="p-8 text-muted">Загрузка&hellip;</Card>;
  return <ActionsTable title="Журнал действий" rows={data ?? []} />;
}
