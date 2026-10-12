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
import {
  ago,
  dateShort,
  daysUntil,
  daysWord,
  money,
  paymentSoon,
  plural,
  uptime,
} from '@/lib/format';
import { type ReachTarget, type ServerReach, reachLevel, useReachAll } from '@/lib/reach';
import { useServers } from '@/lib/servers';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ServerSummary } from '@vps/protocol';
import { CircleAlert, Plus, Search } from 'lucide-react';
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
                  <th>Требует внимания</th>
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

/** Обновление сервиса (lib/service-updates.ts на сервере). */
interface ServiceUpdate {
  kind: 'xui' | 'xray' | 'mtproxyl' | 'mtproxyl-panel';
  title: string;
  latest: string;
}

/** Вкладка сервера, где обновляется сервис: у 3X-UI - своя, движок и панель MTProxyL - MTProxyL. */
const updateTab: Record<ServiceUpdate['kind'], string> = {
  xui: 'xui',
  xray: 'xui',
  mtproxyl: 'mtproxyl',
  'mtproxyl-panel': 'mtproxyl',
};

/** Обновления 3x-ui и MTProxyL по всем серверам: один запрос на страницу. */
function useServiceUpdates() {
  return useQuery({
    queryKey: ['service-updates-all'],
    queryFn: () => api<Record<string, ServiceUpdate[]>>('/api/updates'),
    refetchInterval: 5 * 60_000,
  });
}

/**
 * Что на сервере требует действия: замечания аудита (firewall и docker мимо firewall - тоже
 * замечания), перезагрузка, обновления пакетов и сервисов, устаревший агент. Нечего делать -
 * пусто. Что именно - в подсказке плашки; плашка - ссылка туда, где действие: обновление
 * сервиса - его вкладка, остальное - "Обзор" (замечания и пакеты - блок "Обслуживание", агент и
 * перезагрузка - кнопки в шапке карточки, оплата - "Хостинг"). mobile - ещё то, что на мобиле негде показать
 * отдельно: сервер не в сети и скорая оплата.
 */
function attention(
  s: ServerSummary,
  updates: ServiceUpdate[],
  mobile: boolean,
  reach: ServerReach | undefined,
): {
  key: string;
  tone: 'bad' | 'warn' | 'update';
  text: string;
  title?: string;
  pulse?: boolean;
  /** вкладка карточки сервера с действием; нет - плашка не ссылка */
  tab?: string;
}[] {
  const out: ReturnType<typeof attention> = [];
  if (mobile && s.status === 'offline')
    out.push({ key: 'offline', tone: 'bad', text: `не в сети ${ago(s.lastSeenAt)}` });
  const pending = s.audit?.pendingUpdates ?? 0;
  // строку аудита про пакеты заменяет плашка "пакеты: N"
  const findings = (s.audit?.findings ?? []).filter(
    (f) => !(pending > 0 && f.text.startsWith('Ожидают установки обновлени')),
  );
  const high = findings.filter((f) => f.severity === 'high');
  const medium = findings.filter((f) => f.severity === 'medium');
  if (high.length)
    out.push({
      key: 'high',
      tab: 'overview',
      tone: 'bad',
      text: `${high.length} ${plural(high.length, 'критичное', 'критичных', 'критичных')}`,
      title: high.map((f) => f.text).join('\n'),
    });
  if (medium.length)
    out.push({
      key: 'medium',
      tab: 'overview',
      tone: 'warn',
      text: `${medium.length} ${plural(medium.length, 'замечание', 'замечания', 'замечаний')}`,
      title: medium.map((f) => f.text).join('\n'),
    });
  for (const t of reachProblems(reach))
    out.push({
      key: `reach-${t.key}`,
      tab: t.key === 'mtproxyl' ? 'mtproxyl' : 'overview',
      tone: reachLevel(t.percent) === 'bad' ? 'bad' : 'warn',
      text: `из РФ: ${reachShort(t)} ${t.percent}%`,
      title: `${t.title}: из России дошли ${t.ok} из ${t.total} зондов${t.errors[0] ? ` (${t.errors[0]})` : ''}`,
    });
  if (s.audit?.rebootRequired)
    out.push({
      key: 'reboot',
      tab: 'overview',
      tone: 'warn',
      text: 'перезагрузка',
      title: 'Требуется перезагрузка: обновлено ядро или libc',
    });
  if (pending > 0)
    out.push({
      key: 'packages',
      tab: 'overview',
      tone: 'update',
      text: `пакеты: ${pending}`,
      title: 'Обновления безопасности ждут установки',
    });
  for (const u of updates)
    out.push({
      key: `svc-${u.kind}`,
      tone: 'update',
      text: `${u.title} ${u.latest}`,
      title: `Доступна версия ${u.title} ${u.latest}: обновить на вкладке сервиса`,
      tab: updateTab[u.kind],
    });
  if (s.agentUpdating)
    out.push({
      key: 'agent',
      tone: 'update',
      text: 'агент обновляется',
      pulse: true,
      tab: 'overview',
    });
  else if (s.agentUpdateAvailable)
    out.push({
      key: 'agent',
      tone: 'warn',
      text: 'агент устарел',
      title: `Агент ${s.agentVersion ?? ''}: обновить - кнопкой над списком или в карточке`,
      tab: 'overview',
    });
  if (mobile) {
    const days = daysUntil(s.hosting.nextPaymentAt);
    if (paymentSoon(days))
      out.push({
        key: 'pay',
        tab: 'overview',
        tone: 'warn',
        text: `оплата ${daysWord(days)}`,
        title: `Оплата до ${dateShort(s.hosting.nextPaymentAt)}`,
      });
  }
  return out;
}

/**
 * Что не видно из России: цели ниже 80%. Адрес не виден - inbound-ы того же адреса не
 * перечисляем (их не видно по той же причине), MTProxyL - отдельно (его проверка своя).
 */
function reachProblems(r: ServerReach | undefined): ReachTarget[] {
  const bad = (r?.targets ?? []).filter((t) => {
    const lv = reachLevel(t.percent);
    return lv === 'bad' || lv === 'partial';
  });
  const ip = bad.find((t) => t.key === 'ip' && reachLevel(t.percent) === 'bad');
  return ip ? bad.filter((t) => t === ip || t.source === 'mtproxyl') : bad;
}

function reachShort(t: ReachTarget): string {
  if (t.key === 'ip') return 'адрес';
  if (t.key === 'mtproxyl') return 'MTProxy';
  return t.title.replace(/^3X-UI /, '');
}

function AttentionChips({ s, mobile = false }: { s: ServerSummary; mobile?: boolean }) {
  const { data: updates } = useServiceUpdates();
  const { data: reach } = useReachAll();
  const items = attention(s, updates?.[s.id] ?? [], mobile, reach?.[s.id]);
  if (!items.length) return null;
  const chips = items.map((i) => <AttentionItem key={i.key} i={i} serverId={s.id} />);
  if (!mobile) return <span className="flex flex-wrap gap-1">{chips}</span>;
  // в карточке на мобиле - отдельной полосой под чертой и со значком: не сливается с плашками
  // сервисов строкой выше
  const tone = items.some((i) => i.tone === 'bad')
    ? 'text-bad'
    : items.some((i) => i.tone === 'warn')
      ? 'text-warn'
      : 'text-update';
  return (
    <div className="-mx-3.5 flex items-start gap-2 border-t border-border px-3.5 pt-2.5">
      <CircleAlert
        className={cn('mt-0.5 size-4 shrink-0', tone)}
        role="img"
        aria-label="Требует внимания"
      />
      <span className="flex min-w-0 flex-wrap gap-1">{chips}</span>
    </div>
  );
}

/** Плашка "Требует внимания": ссылка на вкладку с действием, если оно есть. */
function AttentionItem({
  i,
  serverId,
}: { i: ReturnType<typeof attention>[number]; serverId: string }) {
  const chip = (
    <Chip
      tone={i.tone}
      title={i.title}
      dot={i.pulse === true}
      pulse={i.pulse === true}
      className={i.tab ? 'hover:brightness-125' : undefined}
    >
      {i.text}
    </Chip>
  );
  if (!i.tab) return <span className="inline-flex">{chip}</span>;
  return (
    <Link
      to="/servers/$id/$tab"
      params={{ id: serverId, tab: i.tab }}
      className="inline-flex rounded-full focus-visible:outline-2 focus-visible:outline-accent"
    >
      {chip}
    </Link>
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
      </td>
      <td>
        <Resources s={s} />
      </td>
      <td className="min-w-[190px]">
        <div className="flex flex-wrap items-center gap-1.5">
          <ServiceChips services={s.services} links={s.panelLinks} max={4} />
        </div>
      </td>
      <td className="min-w-[230px]">
        <AttentionChips s={s} />
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
        <div className="flex flex-wrap items-center gap-1.5">
          <ServiceChips services={s.services} links={s.panelLinks} max={3} />
        </div>
        <AttentionChips s={s} mobile />
      </Card>
    </div>
  );
}
