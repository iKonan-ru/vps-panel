import { serverOrigin } from '@/components/server-origin';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { TBody, THead, Table } from '@/components/ui/table';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateFull, hm } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  LOG_CATEGORY_TITLES,
  LOG_FEED_CATEGORIES,
  type LogDestRow,
  type LogFeed,
  type LogFeedRow,
} from '@vps/protocol';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { Fragment, useEffect, useState } from 'react';

type FeedCategory = (typeof LOG_FEED_CATEGORIES)[number];

const PERIODS = [
  { id: '1h', title: 'Час', ms: 3_600_000 },
  { id: '24h', title: 'Сутки', ms: 86_400_000 },
  { id: '7d', title: '7 дней', ms: 7 * 86_400_000 },
  { id: '30d', title: '30 дней', ms: 30 * 86_400_000 },
  { id: 'all', title: 'Всё время', ms: 0 },
] as const;
type Period = (typeof PERIODS)[number]['id'];

/** Параметры запроса ленты и назначений; from - от текущего момента. */
function params(o: {
  server: string;
  period: Period;
  level: string;
  cats: FeedCategory[];
  q: string;
}): URLSearchParams {
  const p = new URLSearchParams();
  if (o.server) p.set('servers', o.server);
  const ms = PERIODS.find((x) => x.id === o.period)?.ms ?? 0;
  if (ms) p.set('from', new Date(Date.now() - ms).toISOString());
  if (o.level) p.set('level', o.level);
  if (o.cats.length) p.set('categories', o.cats.join(','));
  if (o.q) p.set('q', o.q);
  return p;
}

/**
 * Лента журнала серверов: события и сеансы подключений, новые первыми, с фильтрами и поиском
 * (адрес, клиент, домен, текст). serverId - лента одного сервера (вкладка сервера). По поиску -
 * ещё и назначения клиентов за период.
 */
export function ServerLogFeed({ serverId }: { serverId?: string }) {
  const { data: servers } = useServers();
  const [server, setServer] = useState('');
  const [period, setPeriod] = useState<Period>('24h');
  const [level, setLevel] = useState('');
  const [cats, setCats] = useState<FeedCategory[]>([]);
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  // поиск - после паузы в наборе
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 400);
    return () => clearTimeout(t);
  }, [search]);

  const filter = { server: serverId ?? server, period, level, cats, q };
  const feed = useInfiniteQuery({
    queryKey: ['log-feed', filter],
    queryFn: ({ pageParam }) => {
      const p = params(filter);
      if (pageParam) p.set('cursor', pageParam);
      return api<LogFeed>(`/api/logs/feed?${p}`);
    },
    initialPageParam: '',
    getNextPageParam: (last) => last.next ?? undefined,
  });
  const dest = useQuery({
    queryKey: ['log-dest', filter],
    queryFn: () => api<LogDestRow[]>(`/api/logs/dest?${params(filter)}`),
    enabled: Boolean(q),
  });

  const rows = feed.data?.pages.flatMap((p) => p.rows) ?? [];
  const busy = feed.isFetching;

  return (
    <>
      <Section
        title={serverId ? 'Журнал сервера' : 'Журнал серверов'}
        info={
          <>
            Связь агента, доступность из России, подключения, действия и изменения на сервере. Сроки
            хранения, выгрузка и удаление&nbsp;&mdash; в&nbsp;настройках.
          </>
        }
      >
        <div className="flex flex-col gap-3 border-b border-border p-4">
          <div
            className={cn('grid grid-cols-2 gap-3', serverId ? 'sm:grid-cols-3' : 'sm:grid-cols-4')}
          >
            <Field label="Период" htmlFor="feed-period">
              <Select
                id="feed-period"
                value={period}
                onChange={(e) => setPeriod(e.target.value as Period)}
              >
                {PERIODS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </Select>
            </Field>
            {!serverId && (
              <Field label="Сервер" htmlFor="feed-server">
                <Select id="feed-server" value={server} onChange={(e) => setServer(e.target.value)}>
                  <option value="">Все серверы</option>
                  {(servers ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                      {serverOrigin(s.hosting) && ` \u00b7 ${serverOrigin(s.hosting)}`}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            <Field label="Уровень" htmlFor="feed-level">
              <Select id="feed-level" value={level} onChange={(e) => setLevel(e.target.value)}>
                <option value="">Все</option>
                <option value="warn">Предупреждения и ошибки</option>
                <option value="error">Ошибки</option>
              </Select>
            </Field>
            <Field label="Поиск" htmlFor="feed-q" className="col-span-2 sm:col-span-1">
              <Input
                id="feed-q"
                type="search"
                value={search}
                placeholder="адрес, клиент, домен, текст"
                onChange={(e) => setSearch(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {LOG_FEED_CATEGORIES.map((c) => (
              <Checkbox
                key={c}
                label={LOG_CATEGORY_TITLES[c]}
                checked={cats.includes(c)}
                onChange={() =>
                  setCats(cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c])
                }
              />
            ))}
          </div>
        </div>
        {feed.error ? (
          <div className="p-4 text-sm text-bad">{feed.error.message}</div>
        ) : feed.isLoading ? (
          <div className="p-4 text-sm text-muted">Загрузка&hellip;</div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-sm text-muted">Записей нет</div>
        ) : (
          <div className="flex flex-col">
            {rows.map((r, i) => {
              const day = dateFull(r.at);
              const newDay = i === 0 || dateFull(rows[i - 1]?.at ?? '') !== day;
              return (
                <Fragment key={r.key}>
                  {newDay && (
                    <div className="border-b border-border bg-surface-2 px-4 py-1.5 text-xs font-medium text-muted">
                      {day}
                    </div>
                  )}
                  <FeedLine
                    row={r}
                    showServer={!serverId}
                    open={open === r.key}
                    onToggle={() => setOpen(open === r.key ? null : r.key)}
                  />
                </Fragment>
              );
            })}
            <div className="flex items-center gap-3 p-4">
              {feed.hasNextPage ? (
                <Button disabled={busy} onClick={() => void feed.fetchNextPage()}>
                  Показать ещё
                </Button>
              ) : (
                <span className="text-xs text-muted">Это все записи за период</span>
              )}
            </div>
          </div>
        )}
      </Section>
      {q && <DestTable rows={dest.data} loading={dest.isLoading} showServer={!serverId} />}
    </>
  );
}

const LEVEL_TONE: Record<string, 'warn' | 'bad' | undefined> = { warn: 'warn', error: 'bad' };
const LEVEL_TITLE: Record<string, string> = { warn: 'внимание', error: 'ошибка' };

function FeedLine({
  row,
  showServer,
  open,
  onToggle,
}: {
  row: LogFeedRow;
  showServer: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const tone = LEVEL_TONE[row.level];
  const cat = LOG_CATEGORY_TITLES[row.category as FeedCategory] ?? 'Журнал';
  return (
    <div className="border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={onToggle}
        className="flex w-full min-w-0 items-start gap-3 px-4 py-2 text-left text-[13px] hover:bg-surface-2"
      >
        {open ? (
          <ChevronDown className="mt-0.5 size-3.5 shrink-0 text-muted" />
        ) : (
          <ChevronRight className="mt-0.5 size-3.5 shrink-0 text-muted" />
        )}
        <span className="shrink-0 tabular-nums text-muted sm:w-24">
          {hm(row.at)}
          {row.until && hm(row.until) !== hm(row.at) && <>&ndash;{hm(row.until)}</>}
        </span>
        <span className="flex min-w-0 grow flex-col gap-1 sm:flex-row sm:items-start sm:gap-3">
          <span className="flex shrink-0 flex-wrap items-baseline gap-1.5 sm:w-56">
            {showServer && row.server && <span className="font-medium">{row.server}</span>}
            <span className="text-xs text-muted">{cat}</span>
          </span>
          <span className="min-w-0 break-words">
            {tone && (
              <Chip tone={tone} className="mr-2 align-middle">
                {LEVEL_TITLE[row.level]}
              </Chip>
            )}
            {row.text}
          </span>
        </span>
      </button>
      {open && <FeedDetails row={row} />}
    </div>
  );
}

interface Probe {
  city: string;
  network: string;
  asn: number;
  ok: boolean;
  rtt?: number;
  error?: string;
}

/** Подробности строки: адрес, клиент, зонды проверки, вывод действия, остальные данные. */
function FeedDetails({ row }: { row: LogFeedRow }) {
  const data = (row.data ?? {}) as Record<string, unknown>;
  const { probes, output, ...rest } = data;
  const probeList = Array.isArray(probes) ? (probes as Probe[]) : [];
  return (
    <div className="flex flex-col gap-3 px-4 pb-3 pl-11 text-[13px]">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted">
        <span>{new Date(row.at).toLocaleString('ru-RU')}</span>
        {row.until && <span>до {new Date(row.until).toLocaleString('ru-RU')}</span>}
        {row.ip && <span className="font-mono">{row.ip}</span>}
        {row.clientId && row.client && (
          <Link to="/clients/$id" params={{ id: row.clientId }} className="underline">
            {row.client}
          </Link>
        )}
        {row.serverId && (
          <Link to="/servers/$id" params={{ id: row.serverId }} className="underline">
            {row.server}
          </Link>
        )}
      </div>
      {probeList.length > 0 && (
        <Table>
          <THead>
            <tr>
              <th>Город</th>
              <th>Сеть</th>
              <th>Итог</th>
            </tr>
          </THead>
          <TBody>
            {probeList.map((p, i) => (
              <tr key={`${p.city}-${p.asn}-${i}`}>
                <td>{p.city}</td>
                <td className="text-muted">
                  {p.network} (AS{p.asn})
                </td>
                <td>
                  {p.ok ? (
                    <Chip tone="ok">{p.rtt !== undefined ? `${p.rtt} мс` : 'дошёл'}</Chip>
                  ) : (
                    <Chip tone="bad">{p.error || 'не дошёл'}</Chip>
                  )}
                </td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
      {typeof output === 'string' && output && (
        <pre className="max-h-64 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs whitespace-pre-wrap">
          {output}
        </pre>
      )}
      {Object.keys(rest).length > 0 && (
        <pre className="max-h-64 overflow-auto rounded-lg bg-bg p-3 font-mono text-xs whitespace-pre-wrap">
          {JSON.stringify(rest, null, 2)}
        </pre>
      )}
    </div>
  );
}

/** Назначения за период по найденному клиенту, пользователю xray или адресу. */
function DestTable({
  rows,
  loading,
  showServer,
}: {
  rows: LogDestRow[] | undefined;
  loading: boolean;
  showServer: boolean;
}) {
  return (
    <Section
      title="Назначения"
      info="Куда ходили клиенты VLESS за период: сумма запросов по журналу доступа Xray. Поиск по клиенту, пользователю xray или адресу назначения."
      extra={rows && <Chip>{rows.length}</Chip>}
    >
      {loading ? (
        <div className="p-4 text-sm text-muted">Загрузка&hellip;</div>
      ) : !rows?.length ? (
        <div className="p-4 text-sm text-muted">Назначений нет</div>
      ) : (
        <Table>
          <THead>
            <tr>
              {showServer && <th>Сервер</th>}
              <th>Клиент</th>
              <th>Назначение</th>
              <th>Маршрут</th>
              <th className="text-right">Запросов</th>
            </tr>
          </THead>
          <TBody>
            {rows.map((r) => (
              <tr key={`${r.serverId}|${r.email}|${r.host}|${r.port}|${r.outbound}`}>
                {showServer && <td className="whitespace-nowrap">{r.server}</td>}
                <td className="whitespace-nowrap">
                  {r.clientId && r.client ? (
                    <Link to="/clients/$id" params={{ id: r.clientId }} className="underline">
                      {r.client}
                    </Link>
                  ) : (
                    <span className="text-muted">{r.email || 'без пользователя'}</span>
                  )}
                </td>
                <td className="break-all font-mono text-xs">
                  {r.host}
                  {r.port ? `:${r.port}` : ''}
                </td>
                <td className="text-muted">{r.outbound}</td>
                <td className="text-right tabular-nums">{r.n.toLocaleString('ru-RU')}</td>
              </tr>
            ))}
          </TBody>
        </Table>
      )}
    </Section>
  );
}
