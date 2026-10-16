import { ActionStatusChip } from '@/components/actions-table';
import { MobileActions } from '@/components/mobile-actions';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { Pager, usePaged } from '@/components/ui/pager';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import {
  type CommandInfo,
  type CommandRun,
  commandsApi,
  groupTitles,
  useCommands,
} from '@/lib/commands';
import { ago } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useQuery } from '@tanstack/react-query';
import { Link, useSearch } from '@tanstack/react-router';
import { Box, Download, FileText, Play, Search, Trash2 } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

/** Каталог команд: карточки по группам и последние запуски. */
export function CommandsPage() {
  const { server } = useSearch({ from: '/app/commands' });
  const { data: cmds } = useCommands();
  const { data: runs } = useQuery({
    queryKey: ['actions', 'command-runs'],
    queryFn: commandsApi.runs,
    refetchInterval: 30_000,
  });
  const { data: servers } = useServers();
  const names = new Map((servers ?? []).map((s) => [s.id, s.name]));
  const [q, setQ] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const { services, groups } = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const list = (cmds ?? []).filter(
      (c) =>
        !needle ||
        c.title.toLowerCase().includes(needle) ||
        c.description.toLowerCase().includes(needle) ||
        c.service?.toLowerCase().includes(needle),
    );
    // команды одного сервиса (установка, удаление) - одна карточка
    const services = new Map<string, CommandInfo[]>();
    const out = new Map<CommandInfo['group'], CommandInfo[]>();
    for (const c of list) {
      if (c.service) services.set(c.service, [...(services.get(c.service) ?? []), c]);
      else out.set(c.group, [...(out.get(c.group) ?? []), c]);
    }
    return { services, groups: out };
  }, [cmds, q]);

  const paged = usePaged(runs ?? []);

  const lastRun = (ids: string[]): CommandRun | undefined =>
    (runs ?? []).find((r) => ids.some((id) => r.kind === `command:${id}`));

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Команды</PageTitle>
        <div className="grow" />
        <Input
          type="search"
          placeholder="Поиск по названию"
          aria-label="Поиск"
          className="hidden w-[260px] md:block"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <MobileActions>
          <Button
            size="icon"
            variant={searchOpen ? 'primary' : 'ghost'}
            aria-label="Поиск"
            onClick={() => setSearchOpen(!searchOpen)}
          >
            <Search className="size-4" />
          </Button>
        </MobileActions>
      </div>
      {searchOpen && (
        <Input
          type="search"
          placeholder="Поиск по названию"
          aria-label="Поиск"
          className="md:hidden"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      {services.size > 0 && (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center gap-2.5">
            <div className="font-semibold">Сервисы</div>
            <Chip>{services.size}</Chip>
          </div>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {[...services].map(([name, list]) => {
              const install = list.find((c) => c.group === 'install');
              const r = lastRun(list.map((c) => c.id));
              const rc = list.find((c) => r?.kind === `command:${c.id}`);
              return (
                <CommandCard
                  key={name}
                  title={name}
                  description={(install ?? list[0])?.description ?? ''}
                  run={r}
                  runLabel={rc ? `${rc.title}: ` : ''}
                  serverName={names.get(r?.serverId ?? '')}
                >
                  {list.map((c) => (
                    <ButtonLink
                      key={c.id}
                      to="/commands/$id"
                      params={{ id: c.id }}
                      search={{ server, run: undefined, tab: undefined }}
                      size="sm"
                      variant={c.group === 'install' ? 'primary' : 'danger'}
                      label={c.group === 'install' ? 'Установить' : 'Удалить с сервера'}
                    >
                      {c.group === 'install' ? (
                        <Download className="size-3.5" />
                      ) : (
                        <Trash2 className="size-3.5" />
                      )}
                    </ButtonLink>
                  ))}
                </CommandCard>
              );
            })}
          </div>
        </div>
      )}

      {(['install', 'maintain'] as const).map((g) => {
        const list = groups.get(g);
        if (!list?.length) return null;
        return (
          <div key={g} className="flex flex-col gap-2.5">
            <div className="flex items-center gap-2.5">
              <div className="font-semibold">{groupTitles[g]}</div>
              <Chip>{list.length}</Chip>
            </div>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {list.map((c) => {
                const r = lastRun([c.id]);
                return (
                  <CommandCard
                    key={c.id}
                    title={c.title}
                    description={c.description}
                    run={r}
                    serverName={names.get(r?.serverId ?? '')}
                  >
                    <ButtonLink
                      to="/commands/$id"
                      params={{ id: c.id }}
                      search={{ server, run: undefined, tab: undefined }}
                      size="sm"
                      variant="primary"
                      label="Запустить"
                    >
                      <Play className="size-3.5" />
                    </ButtonLink>
                  </CommandCard>
                );
              })}
            </div>
          </div>
        );
      })}

      <Section
        title="Последние запуски"
        extra={
          <Link to="/log" className="text-[13px] text-accent hover:underline">
            Весь журнал
          </Link>
        }
      >
        <Table>
          <THead>
            <tr>
              <th>Когда</th>
              <th>Сервер</th>
              <th>Команда</th>
              <th>Итог</th>
              <th />
            </tr>
          </THead>
          <TBody>
            {paged.items.map((r) => {
              const cid = r.kind.replace('command:', '');
              const c = cmds?.find((x) => x.id === cid);
              return (
                <tr key={r.id}>
                  <td className="whitespace-nowrap text-muted">{ago(r.startedAt)}</td>
                  <td>
                    {r.serverId && names.has(r.serverId) ? (
                      <Link
                        to="/servers/$id"
                        params={{ id: r.serverId }}
                        className="hover:text-accent"
                      >
                        {names.get(r.serverId)}
                      </Link>
                    ) : (
                      <span className="text-muted">удалён</span>
                    )}
                  </td>
                  <td>{c?.title ?? cid}</td>
                  <td>
                    <ActionStatusChip finishedAt={r.finishedAt} exitCode={r.exitCode} />
                  </td>
                  <td className="text-right">
                    <ButtonLink
                      to="/commands/$id"
                      params={{ id: cid }}
                      search={{ server: r.serverId ?? undefined, run: r.id, tab: undefined }}
                      size="sm"
                      variant="ghost"
                      label="Вывод"
                    >
                      <FileText className="size-3.5" />
                    </ButtonLink>
                  </td>
                </tr>
              );
            })}
            {runs && runs.length === 0 && (
              <tr>
                <td colSpan={5} className="py-4 text-center text-muted">
                  Запусков пока нет
                </td>
              </tr>
            )}
          </TBody>
        </Table>
        <Pager {...paged} />
      </Section>
    </>
  );
}

/** Карточка каталога: команда или сервис (children - кнопки действий). */
function CommandCard({
  title,
  description,
  run: r,
  runLabel = '',
  serverName,
  children,
}: {
  title: string;
  description: string;
  run: CommandRun | undefined;
  runLabel?: string;
  serverName: string | undefined;
  children: ReactNode;
}) {
  return (
    <Card className="flex min-h-[150px] min-w-0 flex-col gap-2.5 p-4">
      <div className="flex items-center gap-2.5">
        <div className="flex size-[30px] shrink-0 items-center justify-center rounded-lg bg-surface-2 text-accent">
          <Box className="size-4" />
        </div>
        <div className="min-w-0 truncate font-semibold">{title}</div>
        <div className="grow" />
      </div>
      <div className="grow text-[13px] leading-relaxed text-muted">{description}</div>
      {/* последний запуск - целиком, своей строкой (рядом с кнопками он обрезался), кнопки - ниже */}
      <div className="text-xs leading-6 text-muted">
        {r &&
          (r.finishedAt === null ? (
            <Chip tone="accent" className="mr-2 align-middle">
              выполняется
            </Chip>
          ) : r.exitCode === 0 ? (
            <Chip tone="ok" className="mr-2 align-middle">
              успех
            </Chip>
          ) : (
            <Chip tone="bad" className="mr-2 align-middle">
              ошибка
            </Chip>
          ))}
        <span className="break-words">
          {r
            ? `${runLabel}${serverName ?? 'сервер удалён'}, ${ago(r.startedAt)}`
            : 'не запускалась'}
        </span>
      </div>
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border pt-2.5">
        {children}
      </div>
    </Card>
  );
}
