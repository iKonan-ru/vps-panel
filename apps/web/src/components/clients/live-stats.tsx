import { Chip } from '@/components/ui/chip';
import { Num } from '@/components/ui/num';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, bytes } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { GBinding, GClientLive, GLiveBinding, GLiveServer } from '@vps/protocol';
import { useEffect, useRef, useState } from 'react';

/**
 * Живая статистика клиента в карточке: подключение и трафик по привязкам (GET
 * /api/gclients/:id/live раз в 3 с, пока вкладка видна). График скорости сервера - последние
 * HISTORY опросов, только в памяти страницы.
 */

const POLL_MS = 3_000;
const HISTORY = 100;

const rate = (v: number) => `${bytes(v)}/с`;

/** Сумма скоростей привязок (к клиенту и от клиента); null - ни одна не известна. */
function sumRates(list: GLiveBinding[]): { out: number; in: number } | null {
  let known = false;
  let out = 0;
  let inn = 0;
  for (const l of list) {
    if (l.rateOut !== null) {
      out += l.rateOut;
      known = true;
    }
    if (l.rateIn !== null) {
      inn += l.rateIn;
      known = true;
    }
  }
  return known ? { out, in: inn } : null;
}

export interface ClientLive {
  data: GClientLive | undefined;
  binding: (id: string) => GLiveBinding | undefined;
  server: (id: string) => GLiveServer | undefined;
  /** живая статистика привязок сервера */
  ofServer: (serverId: string) => GLiveBinding[];
  /** график: скорость сервера по опросам, байт/с */
  history: (serverId: string) => number[];
}

export function useClientLive(clientId: string, bindings: GBinding[]): ClientLive {
  const { data } = useQuery({
    queryKey: ['gclient-live', clientId],
    queryFn: () => api<GClientLive>(`/api/gclients/${clientId}/live`),
    refetchInterval: POLL_MS,
    retry: false,
    // пока идёт новый запрос - на экране прежние цифры
    placeholderData: (prev) => prev,
  });
  const serverOf = new Map(bindings.map((b) => [b.id, b.serverId]));
  const byBinding = new Map((data?.bindings ?? []).map((l) => [l.bindingId, l]));
  const ofServer = (serverId: string) =>
    (data?.bindings ?? []).filter((l) => serverOf.get(l.bindingId) === serverId);

  const [hist, setHist] = useState(() => new Map<string, number[]>());
  const seen = useRef('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: точка графика - на каждый новый ответ
  useEffect(() => {
    if (!data || data.at === seen.current) return;
    seen.current = data.at;
    setHist((h) => {
      const next = new Map(h);
      for (const s of data.servers) {
        const r = sumRates(ofServer(s.serverId));
        next.set(
          s.serverId,
          [...(next.get(s.serverId) ?? []), r ? r.in + r.out : 0].slice(-HISTORY),
        );
      }
      return next;
    });
  }, [data]);

  return {
    data,
    binding: (id) => byBinding.get(id),
    server: (id) => data?.servers.find((s) => s.serverId === id),
    ofServer,
    history: (id) => hist.get(id) ?? [],
  };
}

/** Подключение одной фразой для подсказки плашки. */
export function liveText(l: GLiveBinding | undefined): string {
  if (!l) return '';
  const parts: string[] = [];
  switch (l.state) {
    case 'online':
      parts.push('на связи');
      break;
    case 'idle':
      parts.push(l.lastSeen ? `не на связи, был ${ago(l.lastSeen)}` : 'не на связи');
      break;
    case 'never':
      parts.push('ни разу не подключался');
      break;
    case 'running':
      parts.push('сервис работает');
      break;
    case 'down':
      parts.push('не работает');
      break;
    case 'missing':
      parts.push('записи на сервере нет');
      break;
    case 'offline':
      parts.push('сервер не в сети');
      break;
    case 'outdated':
      parts.push('агент устарел');
      break;
  }
  if (l.conns !== null && l.state !== 'down') parts.push(`подключений ${l.conns}`);
  if (l.ips) parts.push(`адресов ${l.ips}`);
  if (l.devices !== null) parts.push(`устройств на связи ${l.devices}`);
  if (l.rateOut !== null || l.rateIn !== null)
    parts.push(`к клиенту ${rate(l.rateOut ?? 0)}, от клиента ${rate(l.rateIn ?? 0)}`);
  if (l.totalOut !== null && l.totalIn !== null)
    parts.push(
      `всего${l.sinceStart ? ' с запуска сервиса' : ''}: к клиенту ${bytes(l.totalOut)}, от клиента ${bytes(l.totalIn)}`,
    );
  if (l.note) parts.push(l.note);
  return parts.join(', ');
}

/**
 * Точка плашки: сверка важнее (ошибка - красная, ждёт - серая); заведено - зелёная: залитая и
 * пульсирует - на связи, контур - не на связи; жёлтая - сервис не работает.
 */
export function dotClass(sync: GBinding['state'], l: GLiveBinding | undefined): string {
  if (sync === 'error') return 'bg-bad';
  if (sync === 'pending') return 'bg-muted';
  if (!l) return 'bg-ok';
  switch (l.state) {
    case 'online':
      return 'bg-ok animate-pulse';
    case 'down':
      return 'bg-warn';
    case 'idle':
    case 'never':
    case 'running':
      return 'border border-ok';
    default:
      return 'border border-muted';
  }
}

/** Скорость на плашке: только у тех, кто сейчас качает (от 1 КБ/с). */
export function PillRate({ l }: { l: GLiveBinding | undefined }) {
  const v = (l?.rateOut ?? 0) + (l?.rateIn ?? 0);
  if (!l || l.state !== 'online' || v < 1024) return null;
  return (
    <span className="text-xs text-muted">
      <Num value={v} format={rate} />
    </span>
  );
}

/** Маленький график скорости сервера (последние минуты). */
function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return null;
  const w = 96;
  const h = 20;
  const max = Math.max(1024, ...points);
  // первые точки не жмутся к правому краю: шаг - как будто точек уже не меньше 30
  const step = w / (Math.max(points.length, 30) - 1);
  const x0 = w - (points.length - 1) * step;
  const d = points
    .map((v, i) => `${(x0 + i * step).toFixed(1)},${(h - 1 - (v / max) * (h - 2)).toFixed(1)}`)
    .join(' ');
  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${w} ${h}`}
      className="hidden shrink-0 text-accent sm:block"
      aria-hidden="true"
    >
      <polyline points={d} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

/** Строка сервера под плашками: скорость, всего, график; нет данных - почему. */
export function ServerLive({ serverId, live }: { serverId: string; live: ClientLive }) {
  const s = live.server(serverId);
  if (!s) return null;
  if (!s.online) return <div className="text-xs text-muted">Сервер не в сети.</div>;
  if (s.outdated)
    return (
      <div className="text-xs text-muted">
        Агент устарел - живой статистики нет:{' '}
        <Link to="/servers/$id" params={{ id: serverId }} className="text-accent hover:underline">
          обновить агента
        </Link>
        .
      </div>
    );
  if (s.error) return <div className="text-xs text-warn">Агент не ответил: {s.error}</div>;
  const list = live.ofServer(serverId);
  const r = sumRates(list);
  const withTotals = list.filter((l) => l.totalOut !== null && l.totalIn !== null);
  const total = withTotals.reduce((a, l) => a + (l.totalOut ?? 0) + (l.totalIn ?? 0), 0);
  const partial = withTotals.some((l) => l.sinceStart);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {r ? (
        <span title="Скорость сейчас по счётчикам сервисов">
          к клиенту{' '}
          <span className="text-fg">
            <Num value={r.out} format={rate} />
          </span>
          , от клиента{' '}
          <span className="text-fg">
            <Num value={r.in} format={rate} />
          </span>
        </span>
      ) : (
        <span>скорость - через несколько секунд</span>
      )}
      {withTotals.length > 0 && (
        <span
          title={
            partial
              ? 'Всего по счётчикам сервисов; у AWG и MTProxy - с последнего запуска сервиса'
              : 'Всего по счётчикам сервисов'
          }
        >
          всего {bytes(total)}
        </span>
      )}
      <Spark points={live.history(serverId)} />
    </div>
  );
}

/** Сводка раздела "Серверы": на скольких серверах человек на связи и общая скорость. */
export function LiveSummary({ live }: { live: ClientLive }) {
  const d = live.data;
  if (!d || d.servers.length === 0) return null;
  const onlineServers = d.servers.filter((s) =>
    live.ofServer(s.serverId).some((l) => l.state === 'online'),
  ).length;
  const r = sumRates(d.bindings);
  const v = r ? r.in + r.out : 0;
  return (
    <>
      {onlineServers > 0 ? (
        <Chip tone="ok" dot pulse>
          на связи: {onlineServers} из {d.servers.length}
        </Chip>
      ) : (
        <Chip>не на связи</Chip>
      )}
      {v >= 1024 && (
        <span className={cn('text-xs text-muted')}>
          <Num value={v} format={rate} />
        </span>
      )}
    </>
  );
}
