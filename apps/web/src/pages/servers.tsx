import { useAgentsRollout } from '@/components/agents-rollout';
import { PageActions } from '@/components/page-actions';
import { ServerCard, ServerRow } from '@/components/servers/server-row';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { countryName } from '@/lib/countries';
import { cap } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

export function ServersPage() {
  const { data, isLoading, error } = useServers();
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const servers = useMemo(() => {
    const list = data ?? [];
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((s) =>
      [s.name, s.host, s.hosting.provider, countryName(s.hosting.country), ...s.tags].some((v) =>
        v.toLowerCase().includes(needle),
      ),
    );
  }, [data, q]);
  const online = (data ?? []).filter((s) => s.status === 'online').length;
  const rollout = useAgentsRollout((data ?? []).filter((s) => s.agentUpdateAvailable).length);
  const problems = (data ?? []).filter(
    (s) =>
      (s.audit?.findings.some((f) => f.severity === 'high') ?? false) || s.status === 'offline',
  ).length;

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Серверы</PageTitle>
        <div className="flex flex-wrap gap-2">
          <Chip>всего: {data?.length ?? 0}</Chip>
          <Chip tone="ok">в сети: {online}</Chip>
          {problems > 0 && <Chip tone="bad">с проблемами: {problems}</Chip>}
          {rollout.button}
        </div>
        <div className="grow" />
        <PageActions
          find={{
            label: 'Поиск',
            icon: Search,
            open: searchOpen,
            marked: q.trim() !== '',
            onToggle: () => setSearchOpen(!searchOpen),
          }}
          add={{ label: 'Добавить сервер', to: '/servers/new' }}
        />
      </div>
      {searchOpen && (
        <Input
          type="search"
          placeholder="Имя, адрес или тег"
          aria-label="Поиск"
          className="md:max-w-[360px]"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      {rollout.card}
      {error && <Card className="p-4 text-bad">{cap(error.message)}</Card>}
      {isLoading && <Card className="p-8 text-muted">Загрузка&hellip;</Card>}
      {data && data.length === 0 && (
        <Card className="flex flex-col items-center gap-2 p-12 text-center">
          <div className="text-base font-medium">Серверов пока нет</div>
        </Card>
      )}
      {data && data.length > 0 && (
        <>
          <Card className="hidden overflow-x-auto md:block">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="text-left text-xs text-muted [&>th]:whitespace-nowrap [&>th]:border-b [&>th]:border-border [&>th]:px-3 [&>th]:py-2.5 [&>th]:font-medium">
                  <th>Сервер</th>
                  <th>Хостинг</th>
                  <th>Оплата</th>
                  <th>Состояние</th>
                  <th>Ресурсы</th>
                  <th>Сервисы</th>
                  <th>Требует внимания</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <ServerRow key={s.id} s={s} />
                ))}
              </tbody>
            </table>
          </Card>
          <div className="flex flex-col gap-2.5 md:hidden">
            {servers.map((s) => (
              <ServerCard key={s.id} s={s} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
