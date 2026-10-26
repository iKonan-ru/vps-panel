import { MobileActions } from '@/components/mobile-actions';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { PageTitle } from '@/components/ui/page-title';
import { Placeholder } from '@/components/ui/placeholder';
import { TBody, THead, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { type StdCell, type StdItem, type StdMatrix, serviceByCommand } from '@vps/protocol';
import { Download, RefreshCw } from 'lucide-react';

const tones: Record<StdCell['state'], 'ok' | 'warn' | 'muted' | 'bad'> = {
  ok: 'ok',
  warn: 'warn',
  missing: 'bad',
  unknown: 'muted',
  na: 'muted',
};

/** Вкладка, на которую ведёт сервис в строке сервера: только если сервис там стоит. */
function tabFor(item: StdItem, cell: StdCell): string | undefined {
  const tab = item.install ? serviceByCommand(item.install)?.tab : undefined;
  return cell.state === 'ok' || cell.state === 'warn' ? tab : undefined;
}

/** Клетка: состояние и текст; недостающее - кнопка установки командой каталога. */
function Cell({
  cell,
  serverId,
  online,
  install,
  installHint,
  tab,
}: {
  cell: StdCell;
  serverId: string;
  online: boolean;
  install: string | undefined;
  installHint: string | undefined;
  /** Вкладка сервиса: плашка ведёт на неё. */
  tab?: string | undefined;
}) {
  if (cell.state === 'missing' && install)
    return (
      // сервер не в сети - неактивная кнопка без ссылки вокруг
      online ? (
        <ButtonLink
          to="/commands/$id"
          params={{ id: install }}
          search={{ server: serverId, run: undefined, tab: undefined }}
          size="sm"
          title={installHint ? `Установить: ${installHint}` : undefined}
        >
          <Download className="size-3.5" />
          Установить
        </ButtonLink>
      ) : (
        <Button size="sm" disabled title="Сервер не в сети">
          <Download className="size-3.5" />
          Установить
        </Button>
      )
    );
  if (cell.state === 'na')
    return (
      <span className="text-xs text-muted" title={cell.hint}>
        {cell.text}
      </span>
    );
  const chip = (
    <Chip tone={tones[cell.state]} dot={cell.state === 'ok'}>
      {cell.state === 'ok' ? 'есть' : cell.state === 'warn' ? 'отклонение' : 'нет данных'}
    </Chip>
  );
  return (
    <span className="inline-flex min-w-0 flex-col items-start gap-0.5" title={cell.hint}>
      {tab ? (
        <Link
          to="/servers/$id/$tab"
          params={{ id: serverId, tab }}
          className="rounded-full hover:brightness-125 focus-visible:outline-2 focus-visible:outline-accent"
        >
          {chip}
        </Link>
      ) : (
        chip
      )}
      <span className="text-xs text-muted max-md:line-clamp-2 md:max-w-[180px] md:truncate">
        {cell.text}
      </span>
      {/* подробности отклонения видны и без наведения (на телефоне его нет), но не больше двух
          строк: длинное описание (OpenFlux) раздувало бы карточку сервера */}
      {cell.state === 'warn' && cell.hint && (
        <span className="text-xs text-warn max-md:line-clamp-2 md:max-w-[180px] md:truncate">
          {cell.hint}
        </span>
      )}
    </span>
  );
}

/**
 * Матрица "серверы x сервисы" по эталону: что стоит, где отклонения (обновления, нет своих
 * inbound-ов 3X-UI), чего не хватает - с установкой командой каталога. Сервер панели не входит.
 */
export function ServicesPage() {
  const { data, error, isFetching, refetch } = useQuery({
    queryKey: ['standard'],
    queryFn: () => api<StdMatrix>('/api/standard'),
    staleTime: 60_000,
  });

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Сервисы</PageTitle>
        <div className="grow" />
        <Button
          size="sm"
          className="max-md:hidden"
          disabled={isFetching}
          onClick={() => void refetch()}
          label="Обновить"
        >
          <RefreshCw className={cn('size-3.5', isFetching && 'animate-spin')} />
        </Button>
        <MobileActions>
          <Button
            size="icon"
            variant="ghost"
            disabled={isFetching}
            onClick={() => void refetch()}
            aria-label="Обновить"
            title="Обновить"
          >
            <RefreshCw className={cn('size-4', isFetching && 'animate-spin')} />
          </Button>
        </MobileActions>
      </div>
      {error && <Alert tone="bad">{error.message}</Alert>}
      {!data && !error && <Placeholder>Загрузка&hellip;</Placeholder>}
      {data && (
        <>
          <Card className="hidden overflow-hidden md:block">
            <Table>
              <THead>
                <tr>
                  <th>Сервер</th>
                  {data.standard.map((s) => (
                    <th key={s.key}>{s.title}</th>
                  ))}
                </tr>
              </THead>
              <TBody>
                {data.rows.map((r) => (
                  <tr key={r.serverId}>
                    <td className="align-top">
                      <Link
                        to="/servers/$id"
                        params={{ id: r.serverId }}
                        className="font-semibold text-text hover:text-accent"
                      >
                        {r.name}
                      </Link>
                      {r.status !== 'online' && (
                        <div className="text-xs text-muted">не в сети: данные прошлого опроса</div>
                      )}
                    </td>
                    {data.standard.map((s) => (
                      <td key={s.key} className="align-top">
                        <Cell
                          cell={r.cells[s.key]}
                          serverId={r.serverId}
                          online={r.status === 'online'}
                          install={s.install}
                          installHint={s.installHint}
                          tab={tabFor(s, r.cells[s.key])}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </TBody>
            </Table>
          </Card>
          <div className="flex flex-col gap-3 md:hidden">
            {data.rows.map((r) => (
              <Card key={r.serverId} className="flex flex-col gap-2 p-3.5">
                <Link
                  to="/servers/$id"
                  params={{ id: r.serverId }}
                  className="font-semibold text-text"
                >
                  {r.name}
                  {r.status !== 'online' && (
                    <span className="ml-2 text-xs font-normal text-muted">не в сети</span>
                  )}
                </Link>
                {data.standard.map((s) => {
                  const tab = tabFor(s, r.cells[s.key]);
                  return (
                    <div key={s.key} className="flex items-center gap-3">
                      {tab ? (
                        <Link
                          to="/servers/$id/$tab"
                          params={{ id: r.serverId, tab }}
                          className="w-20 shrink-0 text-[13px] text-accent"
                        >
                          {s.title}
                        </Link>
                      ) : (
                        <div className="w-20 shrink-0 text-[13px]">{s.title}</div>
                      )}
                      <div className="min-w-0 grow">
                        <Cell
                          cell={r.cells[s.key]}
                          serverId={r.serverId}
                          online={r.status === 'online'}
                          install={s.install}
                          installHint={s.installHint}
                          tab={tab}
                        />
                      </div>
                    </div>
                  );
                })}
              </Card>
            ))}
          </div>
        </>
      )}
    </>
  );
}
