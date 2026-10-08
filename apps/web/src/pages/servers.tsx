import { useAgentsRollout } from '@/components/agents-rollout';
import { MobileActions } from '@/components/mobile-actions';
import { ServerStatusChip } from '@/components/server-status';
import { ServiceChips } from '@/components/service-chips';
import { Bar } from '@/components/ui/bar';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { countryLabel, countryName } from '@/lib/countries';
import { dateShort, daysUntil, money, paymentSoon, uptime } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ServerSummary } from '@vps/protocol';
import { Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

/** Сводка серверов: таблица по макету, данные живые. */
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
          <Chip>всего {data?.length ?? 0}</Chip>
          <Chip tone="ok">в сети {online}</Chip>
          {problems > 0 && <Chip tone="bad">с проблемами {problems}</Chip>}
          {rollout.button}
        </div>
        <div className="grow" />
        <Input
          type="search"
          placeholder="Поиск по имени, адресу, тегу"
          aria-label="Поиск"
          className="hidden w-[260px] md:block"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <ButtonLink
          to="/servers/new"
          variant="primary"
          label="Добавить сервер"
          className="max-md:hidden"
        >
          <Plus className="size-4" />
        </ButtonLink>
      </div>
      {/* на мобиле поиск и добавление - иконками в верхней плашке; строка поиска по клику */}
      <MobileActions>
        <Button
          size="icon"
          variant={searchOpen ? 'primary' : 'ghost'}
          aria-label="Поиск"
          onClick={() => setSearchOpen(!searchOpen)}
        >
          <Search className="size-4" />
        </Button>
        <ButtonLink to="/servers/new" size="icon" variant="primary" aria-label="Добавить сервер">
          <Plus className="size-4" />
        </ButtonLink>
      </MobileActions>
      {searchOpen && (
        <Input
          type="search"
          placeholder="Поиск по имени, адресу, тегу"
          aria-label="Поиск"
          className="md:hidden"
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      )}

      {rollout.card}
      {error && <Card className="p-4 text-bad">{error.message}</Card>}
      {isLoading && <Card className="p-8 text-muted">Загрузка...</Card>}
      {data && data.length === 0 && (
        <Card className="flex flex-col items-center gap-2 p-12 text-center">
          <div className="text-base font-medium">Серверов пока нет</div>
          <div className="max-w-md text-[13px] text-muted">
            Добавь первый сервер: панель выдаст команду установки агента, а дальше покажет
            состояние, firewall и контейнеры.
          </div>
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
                  <th>Безопасность</th>
                  <th>Firewall</th>
                  <th>Обновления</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <Row key={s.id} s={s} />
                ))}
              </tbody>
            </table>
          </Card>
          <div className="flex flex-col gap-2.5 md:hidden">
            {servers.map((s) => (
              <MobileCard key={s.id} s={s} />
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** Обновления 3x-ui и MTProxyL по всем серверам: один запрос на страницу. */
function useServiceUpdates() {
  return useQuery({
    queryKey: ['service-updates-all'],
    queryFn: () => api<Record<string, { title: string; latest: string }[]>>('/api/updates'),
    refetchInterval: 5 * 60_000,
  });
}

/** className - выравнивание блока чипов (в карточке на мобиле - по правому краю). */
function SecurityChip({ s, className }: { s: ServerSummary; className?: string }) {
  const { data: updates } = useServiceUpdates();
  if (!s.audit) return <span className="text-muted">-</span>;
  const high = s.audit.findings.filter((f) => f.severity === 'high').length;
  const medium = s.audit.findings.filter((f) => f.severity === 'medium').length;
  // обновления сервисов и пакетов - отдельным чипом, что именно - в подсказке
  const upd = [
    ...(updates?.[s.id] ?? []).map((u) => `${u.title} ${u.latest}`),
    ...(s.audit.pendingUpdates > 0 ? [`пакеты: ${s.audit.pendingUpdates}`] : []),
  ];
  // без замечаний и обновлений показывать нечего: плашка "нет замечаний" только шумит
  if (!high && !medium && upd.length === 0) return null;
  return (
    <span className={cn('inline-flex flex-wrap gap-1', className)}>
      {high ? (
        <Chip tone="bad">{high} критичных</Chip>
      ) : (
        medium > 0 && <Chip tone="warn">{medium} средних</Chip>
      )}
      {upd.length > 0 && (
        <span title={`Обновления: ${upd.join(', ')}`}>
          <Chip tone="accent">обновления</Chip>
        </span>
      )}
    </span>
  );
}

function PayCell({ s }: { s: ServerSummary }) {
  const h = s.hosting;
  const days = daysUntil(h.nextPaymentAt);
  const soon = paymentSoon(days);
  if (h.price === null && !h.nextPaymentAt) return <span className="text-muted">-</span>;
  return (
    <div className={soon ? 'text-warn' : ''}>
      <div className="whitespace-nowrap">{money(h.price, h.currency, h.billingMonths)}</div>
      {h.nextPaymentAt && (
        <div className={`mt-0.5 text-xs ${soon ? 'text-warn' : 'text-muted'}`}>
          до {dateShort(h.nextPaymentAt)}
        </div>
      )}
    </div>
  );
}

function Resources({ s }: { s: ServerSummary }) {
  const m = s.metrics;
  if (!m || s.status !== 'online') return <span className="text-muted">-</span>;
  return (
    <div className="grid grid-cols-[32px_1fr] items-center gap-x-1.5 gap-y-0.5 whitespace-nowrap text-[11px] text-muted">
      <span>CPU</span>
      <Bar pct={m.cpuPercent} />
      <span>RAM</span>
      <Bar pct={(m.memUsedMb / Math.max(1, m.memTotalMb)) * 100} />
      <span>Диск</span>
      <Bar pct={(m.diskUsedGb / Math.max(1, m.diskTotalGb)) * 100} />
    </div>
  );
}

function Row({ s }: { s: ServerSummary }) {
  const navigate = useNavigate();
  const open = () => navigate({ to: '/servers/$id', params: { id: s.id } });
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиатурный путь - ссылка на имени сервера внутри строки
    <tr
      onClick={(e) => {
        // Клик по ссылке или кнопке внутри строки обрабатывают они сами.
        if ((e.target as HTMLElement).closest('a, button')) return;
        void open();
      }}
      className="cursor-pointer hover:bg-surface-2 [&>td]:border-b [&>td]:border-border [&>td]:px-3 [&>td]:py-2.5 [&>td]:align-middle"
    >
      <td>
        <Link
          to="/servers/$id"
          params={{ id: s.id }}
          className="font-semibold text-text hover:text-accent"
        >
          {s.name}
        </Link>
        <div className="mt-0.5 flex items-center gap-2 font-mono text-xs text-muted">
          {s.host}
          {s.panelHost && <PanelHostChip />}
        </div>
      </td>
      <td className="whitespace-nowrap">
        {s.hosting.country && <span>{countryLabel(s.hosting.country)} </span>}
        <span className="text-muted">{s.hosting.provider}</span>
      </td>
      <td>
        <PayCell s={s} />
      </td>
      <td>
        <ServerStatusChip s={s} />
        {s.metrics && s.status === 'online' && (
          <div className="mt-1 text-xs text-muted">аптайм {uptime(s.metrics.uptimeSec)}</div>
        )}
        {s.agentUpdating ? (
          <div className="mt-1 text-xs text-accent">агент обновляется...</div>
        ) : (
          s.agentUpdateAvailable && (
            <div className="mt-1 text-xs text-warn" title={`агент ${s.agentVersion ?? ''}`}>
              агент устарел
            </div>
          )
        )}
      </td>
      <td>
        <Resources s={s} />
      </td>
      <td className="min-w-[190px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <ServiceChips services={s.services} links={s.panelLinks} max={4} />
        </div>
      </td>
      <td>
        <SecurityChip s={s} />
      </td>
      <td>
        {s.firewall ? (
          <div className="flex flex-wrap gap-1">
            {s.firewall.ufwActive ? <Chip tone="ok">вкл</Chip> : <Chip tone="bad">выкл</Chip>}
            {s.firewall.ufwActive && s.dockerVersion && !s.firewall.dockerFiltered && (
              <Chip
                tone="bad"
                title="Порты контейнеров идут мимо firewall: цепочка DOCKER-USER не фильтруется"
              >
                docker мимо firewall
              </Chip>
            )}
          </div>
        ) : (
          <span className="text-muted">-</span>
        )}
      </td>
      <td>
        {s.audit ? (
          s.audit.pendingUpdates > 0 ? (
            <Chip tone="warn">{s.audit.pendingUpdates} ждут</Chip>
          ) : (
            <Chip tone="ok">0</Chip>
          )
        ) : (
          <span className="text-muted">-</span>
        )}
        {s.audit?.rebootRequired && (
          <div className="mt-1 text-xs text-warn">нужна перезагрузка</div>
        )}
      </td>
    </tr>
  );
}

/** Сервер, на котором стоит сама панель: глобальные клиенты на нём не создаются. */
function PanelHostChip() {
  return (
    <Chip tone="accent" className="font-sans" title="На этом сервере стоит панель">
      панель
    </Chip>
  );
}

function MobileCard({ s }: { s: ServerSummary }) {
  const navigate = useNavigate();
  return (
    // Не ссылка целиком: внутри ссылки на панели сервисов, а вложенная ссылка уводила бы на
    // карточку сервера вместо панели. Клавиатурный путь - ссылка на имени.
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиатурный путь - ссылка на имени сервера
    <div
      className="cursor-pointer"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        void navigate({ to: '/servers/$id', params: { id: s.id } });
      }}
    >
      <Card className="flex flex-col gap-2 p-3.5">
        <div className="flex items-center gap-2">
          <Link to="/servers/$id" params={{ id: s.id }} className="font-semibold text-text">
            {s.name}
          </Link>
          {s.panelHost && <PanelHostChip />}
          <span className="text-xs text-muted">
            {countryLabel(s.hosting.country)} {s.hosting.provider}
          </span>
          <div className="grow" />
          <ServerStatusChip s={s} dotOnly />
        </div>
        {s.metrics && s.status === 'online' && (
          <div className="flex gap-2.5 text-xs text-muted">
            <span>CPU {Math.round(s.metrics.cpuPercent)}%</span>
            <span>
              RAM {Math.round((s.metrics.memUsedMb / Math.max(1, s.metrics.memTotalMb)) * 100)}%
            </span>
            <span>
              Диск {Math.round((s.metrics.diskUsedGb / Math.max(1, s.metrics.diskTotalGb)) * 100)}%
            </span>
          </div>
        )}
        <div className="flex items-center gap-1.5">
          <ServiceChips services={s.services} links={s.panelLinks} max={3} />
          <div className="grow" />
          <SecurityChip s={s} className="justify-end" />
        </div>
      </Card>
    </div>
  );
}
