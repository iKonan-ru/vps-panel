import { Breadcrumbs } from '@/components/breadcrumbs';
import { byServer, pillLabel } from '@/components/clients/binding-pill';
import {
  type ClientLive,
  liveState,
  liveTone,
  rate,
  sumRates,
  useClientLive,
} from '@/components/clients/live-stats';
import { RateChart } from '@/components/clients/rate-chart';
import { Alert } from '@/components/ui/alert';
import { ButtonLink } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Num } from '@/components/ui/num';
import { PageTitle } from '@/components/ui/page-title';
import { LoadState } from '@/components/ui/placeholder';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { ago, bytes, cap, dateTime } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import {
  type ClientConnsView,
  type GBinding,
  type GClientDetail,
  type GDevice,
  type GLiveBinding,
  serviceByBinding,
} from '@vps/protocol';
import { Server, SquareArrowOutUpRight } from 'lucide-react';
import type { ReactNode } from 'react';

/** Клиент на одном сервере: живая статистика по сервисам. */
export function ClientServerPage() {
  const { id, serverId } = useParams({ from: '/app/clients/$id/servers/$serverId' });
  const { data, error } = useQuery({
    queryKey: ['gclient', id],
    queryFn: () => api<GClientDetail>(`/api/gclients/${id}`),
    refetchInterval: 10_000,
  });
  const bindings = (data?.bindings ?? []).filter((b) => b.serverId === serverId);
  const live = useClientLive(id, bindings, serverId);

  if (error || !data) return <LoadState error={error} />;
  const c = data.client;
  const list = byServer(bindings)[0]?.[1] ?? [];
  const serverName = list[0]?.serverName ?? 'Сервер';
  const crumbs = [
    { label: 'Клиенты', to: '/clients' },
    { label: c.name, to: `/clients/${id}` },
    { label: serverName },
  ];
  if (list.length === 0)
    return (
      <>
        <Breadcrumbs items={crumbs} />
        <Alert tone="info">
          У клиента нет записей на этом сервере.{' '}
          <Link to="/clients/$id" params={{ id }} className="text-accent hover:underline">
            К карточке клиента
          </Link>
        </Alert>
      </>
    );

  const s = live.server(serverId);
  const lives = live.ofServer(serverId);
  const devices = new Map(data.devices.map((d) => [d.id, d]));

  return (
    <>
      <Breadcrumbs items={crumbs} />
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>{serverName}</PageTitle>
        <span className="text-[13px] text-muted">{c.name}</span>
        <div className="grow" />
        <ButtonLink
          to="/servers/$id"
          params={{ id: serverId }}
          size="sm"
          label="Сервер"
          title="Карточка сервера"
        >
          <Server className="size-3.5" />
        </ButtonLink>
      </div>
      {s && !s.online && <Alert tone="info">Сервер не в сети: живой статистики нет</Alert>}
      {s?.error && <Alert tone="bad">Агент не ответил: {s.error}</Alert>}

      <ServerNow live={live} serverId={serverId} lives={lives} total={list.length} />
      <ClientConns clientId={id} serverId={serverId} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        {list.map((b) => (
          <ServiceCard
            key={b.id}
            b={b}
            device={b.deviceId ? devices.get(b.deviceId) : undefined}
            l={live.binding(b.id)}
            live={live}
            serverId={serverId}
          />
        ))}
      </div>
    </>
  );
}

function Tile({
  label,
  children,
  note,
}: { label: string; children: ReactNode; note?: string | undefined }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="truncate text-lg font-semibold">{children}</div>
      {note && <div className="text-xs text-muted">{note}</div>}
    </div>
  );
}

/** Сводка сервера: скорость сейчас, всего, на связи в скольких сервисах, общий график. */
function ServerNow({
  live,
  serverId,
  lives,
  total,
}: {
  live: ClientLive;
  serverId: string;
  lives: GLiveBinding[];
  total: number;
}) {
  const r = sumRates(lives);
  const withTotals = lives.filter((l) => l.totalOut !== null && l.totalIn !== null);
  const totalOut = withTotals.reduce((a, l) => a + (l.totalOut ?? 0), 0);
  const totalIn = withTotals.reduce((a, l) => a + (l.totalIn ?? 0), 0);
  const online = lives.filter((l) => l.state === 'online').length;
  return (
    <Section title="Сейчас на сервере">
      <div className="flex flex-col gap-4 px-4 py-3">
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Tile label="К клиенту">{r ? <Num value={r.out} format={rate} /> : '-'}</Tile>
          <Tile label="От клиента">{r ? <Num value={r.in} format={rate} /> : '-'}</Tile>
          <Tile
            label="Всего"
            note={
              withTotals.some((l) => l.sinceStart)
                ? 'у AWG и MTProxy\u00a0\u2014 с запуска сервиса'
                : undefined
            }
          >
            {withTotals.length ? bytes(totalOut + totalIn) : '-'}
          </Tile>
          <Tile label="На связи">
            {online} из {total}
          </Tile>
        </div>
        <RateChart points={live.serverHistory(serverId)} />
      </div>
    </Section>
  );
}

const linkCls = 'text-accent hover:underline';

/**
 * Адреса клиента на сервере сейчас: соединения и порты, чем опознан (VLESS, AWG) и тот же адрес на
 * других серверах - у этого клиента или неопознанным (тогда, вероятно, это тоже он).
 */
function ClientConns({ clientId, serverId }: { clientId: string; serverId: string }) {
  const { data, error } = useQuery({
    queryKey: ['gclient', clientId, 'servers', serverId, 'connections'],
    queryFn: () =>
      api<ClientConnsView>(`/api/gclients/${clientId}/servers/${serverId}/connections`),
    refetchInterval: 5_000,
  });
  const reason = error?.message ?? data?.error;
  return (
    <Section
      title="Адреса"
      info="С каких адресов клиент подключён к серверу и тот же адрес на других серверах. За одним адресом (мобильная сеть, NAT) могут быть и другие люди"
      extra={<span className="text-xs text-muted">обновляется раз в 5&nbsp;с</span>}
    >
      {!data && !reason && <div className="px-4 py-3 text-[13px] text-muted">Загрузка&hellip;</div>}
      {reason && <div className="px-4 py-3 text-[13px] text-muted">{cap(reason)}</div>}
      {data && !data.error && data.addrs.length === 0 && (
        <div className="px-4 py-3 text-[13px] text-muted">Сейчас подключений нет</div>
      )}
      {data?.addrs.map((a) => (
        <div
          key={a.ip}
          className="flex flex-col gap-1.5 border-b border-border px-4 py-3 text-[13px] last:border-b-0"
        >
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <span className="font-mono select-all">{a.ip}</span>
            <span className="text-xs text-muted">{a.via.join(', ')}</span>
            <div className="grow" />
            {a.conns > 0 ? (
              <span className="tabular-nums">
                {a.conns}
                <span className="text-xs text-muted"> соед.</span>
              </span>
            ) : (
              a.handshakeAt && (
                <span className="text-xs text-muted">handshake {ago(a.handshakeAt)}</span>
              )
            )}
          </div>
          {a.ports.length > 0 && (
            <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
              {a.ports.map((p) => (
                <span key={p.port} className="tabular-nums">
                  порт <span className="font-mono text-text">{p.port}</span>
                  {p.label && ` ${p.label}`}: {p.conns}
                </span>
              ))}
            </div>
          )}
          {a.elsewhere.map((e) =>
            e.kind === 'unknown' ? (
              <div key={e.serverId} className="text-xs text-warn">
                На{' '}
                <Link
                  to="/servers/$id/$tab"
                  params={{ id: e.serverId, tab: 'conns' }}
                  className={linkCls}
                >
                  {e.serverName}
                </Link>{' '}
                этот адрес не опознан ({e.conns}&nbsp;соед.): вероятно, это тоже этот клиент
              </div>
            ) : (
              <div key={e.serverId} className="text-xs text-muted">
                С этого же адреса клиент был на{' '}
                <Link
                  to="/clients/$id/servers/$serverId"
                  params={{ id: clientId, serverId: e.serverId }}
                  className={linkCls}
                >
                  {e.serverName}
                </Link>
                , {ago(e.at)}
              </div>
            ),
          )}
        </div>
      ))}
    </Section>
  );
}

function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="min-w-0 truncate tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Один сервис клиента на сервере: состояние, цифры, график. */
function ServiceCard({
  b,
  device,
  l,
  live,
  serverId,
}: {
  b: GBinding;
  device: GDevice | undefined;
  l: GLiveBinding | undefined;
  live: ClientLive;
  serverId: string;
}) {
  const svc = serviceByBinding(b.service);
  const tab = svc?.tab;
  const hasCounters = Boolean(svc?.counters);
  const rows: [string, ReactNode][] = [];
  if (b.state === 'pending') rows.push(['Синхронизация', 'ждёт']);
  if (b.state === 'error')
    rows.push([
      'Синхронизация',
      <span key="sync" className="text-bad">
        {b.error}
      </span>,
    ]);
  if (l && hasCounters) {
    rows.push([
      'К клиенту',
      l.rateOut === null ? '-' : <Num key="out" value={l.rateOut} format={rate} />,
    ]);
    rows.push([
      'От клиента',
      l.rateIn === null ? '-' : <Num key="in" value={l.rateIn} format={rate} />,
    ]);
    if (l.totalOut !== null && l.totalIn !== null)
      rows.push([
        l.sinceStart ? 'Всего с запуска' : 'Всего',
        `${bytes(l.totalOut)} к клиенту, ${bytes(l.totalIn)} от клиента`,
      ]);
  }
  if (l?.lastSeen) rows.push(['Активность', `${dateTime(l.lastSeen)} (${ago(l.lastSeen)})`]);
  if (l?.conns !== null && l?.conns !== undefined) rows.push(['Подключений', l.conns]);
  if (l?.ips !== null && l?.ips !== undefined) rows.push(['Адресов', l.ips]);
  if (l?.devices !== null && l?.devices !== undefined) rows.push(['Устройств на связи', l.devices]);

  return (
    <Section
      title={pillLabel(b, device)}
      extra={
        l && (
          <Chip tone={liveTone(l)} dot pulse={l.state === 'online'}>
            {liveState(l)}
          </Chip>
        )
      }
      actions={
        tab && (
          <ButtonLink
            to="/servers/$id/$tab"
            params={{ id: serverId, tab }}
            size="sm"
            variant="ghost"
            label="Вкладка"
            title="Вкладка сервиса на сервере"
          >
            <SquareArrowOutUpRight className="size-3.5" />
          </ButtonLink>
        )
      }
    >
      <div className="flex flex-col gap-3 px-4 py-3">
        {rows.length > 0 && <Facts rows={rows} />}
        {l?.note && <div className="text-xs text-muted">{l.note}</div>}
        {!l && <div className="text-[13px] text-muted">Загрузка&hellip;</div>}
        {hasCounters && l && l.state !== 'offline' && l.state !== 'outdated' && (
          <RateChart points={live.history(b.id)} height={110} />
        )}
      </div>
    </Section>
  );
}
