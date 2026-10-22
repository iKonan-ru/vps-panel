import { useAgentsRollout } from '@/components/agents-rollout';
import { PageActions } from '@/components/page-actions';
import { ServerCard, ServerRow } from '@/components/servers/server-row';
import { ServerTags } from '@/components/servers/server-tags';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { countryName } from '@/lib/countries';
import { cap } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { tagKey, useTags } from '@/lib/tags';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Search } from 'lucide-react';
import { useMemo, useState } from 'react';

export function ServersPage() {
  const { data, isLoading, error } = useServers();
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const { tag } = useSearch({ from: '/app/' });
  const navigate = useNavigate();
  // повторный выбор того же тега снимает фильтр
  const pickTag = (t: string) =>
    void navigate({
      to: '/',
      search: tag && tagKey(tag) === tagKey(t) ? {} : { tag: t },
      replace: true,
    });
  const { data: tagList } = useTags();
  // в ряду фильтров - теги, которые стоят хотя бы на одном сервере
  const usedTags = (tagList ?? []).filter((t) => t.servers > 0).map((t) => t.name);
  const servers = useMemo(() => {
    let list = data ?? [];
    if (tag) list = list.filter((s) => s.tags.some((t) => tagKey(t) === tagKey(tag)));
    const needle = q.trim().toLowerCase();
    if (!needle) return list;
    return list.filter((s) =>
      [s.name, s.host, s.hosting.provider, countryName(s.hosting.country), ...s.tags].some((v) =>
        v.toLowerCase().includes(needle),
      ),
    );
  }, [data, q, tag]);
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
          className="animate-reveal md:max-w-[360px]"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      {usedTags.length > 0 && (
        <ServerTags tags={usedTags} onPick={pickTag} active={tag} className="gap-1.5" />
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
          {servers.length === 0 && (
            <Card className="p-8 text-center text-muted">Ничего не найдено</Card>
          )}
          <Card className={servers.length ? 'hidden overflow-x-auto md:block' : 'hidden'}>
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
                {servers.map((s, i) => (
                  <ServerRow key={s.id} s={s} i={i} tag={tag} onTag={pickTag} />
                ))}
              </tbody>
            </table>
          </Card>
          <div className="flex flex-col gap-2.5 md:hidden">
            {servers.map((s, i) => (
              <ServerCard key={s.id} s={s} i={i} tag={tag} onTag={pickTag} />
            ))}
          </div>
        </>
      )}
    </>
  );
}
