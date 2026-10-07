import { Chip } from '@/components/ui/chip';
import { Num } from '@/components/ui/num';
import { api } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import type { GBinding, GClientLive, GLiveBinding, GLiveServer } from '@vps/protocol';
import { useEffect, useRef, useState } from 'react';

/**
 * Живая статистика клиента: GET /api/gclients/:id/live раз в 3 с, пока страница открыта и
 * вкладка видна (в фоне TanStack Query опрос не ведёт). Карточка клиента берёт отсюда точки на
 * плашках и сводку, страница сервера клиента - всё по сервисам и графики. История для графиков -
 * последние HISTORY_MS, только в памяти страницы.
 */

const POLL_MS = 3_000;
/** Окно графиков: последние 5 минут. */
export const HISTORY_MS = 5 * 60_000;

export const rate = (v: number) => `${bytes(v)}/с`;

/** Точка графика: время ответа и скорость к клиенту и от клиента (null - неизвестна). */
export interface RatePoint {
  t: number;
  out: number | null;
  in: number | null;
}

/** Сумма скоростей привязок; null - ни одна не известна. */
export function sumRates(list: GLiveBinding[]): { out: number; in: number } | null {
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
  /** скорость привязки по опросам */
  history: (bindingId: string) => RatePoint[];
  /** скорость сервера (сумма привязок) по опросам */
  serverHistory: (serverId: string) => RatePoint[];
}

/** serverId - только этот сервер (страница сервера клиента), иначе - все серверы клиента. */
export function useClientLive(
  clientId: string,
  bindings: GBinding[],
  serverId?: string,
): ClientLive {
  const { data } = useQuery({
    queryKey: ['gclient-live', clientId, serverId ?? ''],
    queryFn: () =>
      api<GClientLive>(
        `/api/gclients/${clientId}/live${serverId ? `?server=${encodeURIComponent(serverId)}` : ''}`,
      ),
    refetchInterval: POLL_MS,
    retry: false,
    // пока идёт новый запрос - на экране прежние цифры
    placeholderData: (prev) => prev,
  });
  const serverOf = new Map(bindings.map((b) => [b.id, b.serverId]));
  const byBinding = new Map((data?.bindings ?? []).map((l) => [l.bindingId, l]));
  const ofServer = (sid: string) =>
    (data?.bindings ?? []).filter((l) => serverOf.get(l.bindingId) === sid);

  const [hist, setHist] = useState(() => new Map<string, RatePoint[]>());
  const seen = useRef('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: точка графиков - на каждый новый ответ
  useEffect(() => {
    if (!data || data.at === seen.current) return;
    seen.current = data.at;
    const t = new Date(data.at).getTime();
    setHist((h) => {
      const next = new Map(h);
      const push = (key: string, p: RatePoint) =>
        next.set(
          key,
          [...(next.get(key) ?? []), p].filter((x) => t - x.t <= HISTORY_MS),
        );
      for (const l of data.bindings) push(l.bindingId, { t, out: l.rateOut, in: l.rateIn });
      for (const s of data.servers) {
        const r = sumRates(ofServer(s.serverId));
        push(`server:${s.serverId}`, { t, out: r?.out ?? null, in: r?.in ?? null });
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
    serverHistory: (id) => hist.get(`server:${id}`) ?? [],
  };
}

/** Подключение коротко: для плашки состояния и подсказки. */
export function liveState(l: GLiveBinding | undefined): string {
  if (!l) return '';
  switch (l.state) {
    case 'online':
      return 'на связи';
    case 'idle':
      return l.lastSeen ? `был ${ago(l.lastSeen)}` : 'не на связи';
    case 'never':
      return 'ни разу не подключался';
    case 'running':
      return 'сервис работает';
    case 'down':
      return 'не работает';
    case 'missing':
      return 'записи на сервере нет';
    case 'offline':
      return 'сервер не в сети';
    case 'outdated':
      return 'агент устарел';
  }
}

/** Тон плашки состояния подключения. */
export function liveTone(l: GLiveBinding | undefined): 'ok' | 'warn' | 'muted' {
  if (l?.state === 'online') return 'ok';
  if (l?.state === 'down') return 'warn';
  return 'muted';
}

/** Подсказка плашки на карточке клиента: состояние и пояснение. */
export function liveText(l: GLiveBinding | undefined): string {
  if (!l) return '';
  return [liveState(l), l.note].filter(Boolean).join(', ');
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

/** Отметка у сервера на карточке клиента: человек на связи хотя бы в одном сервисе. */
export function ServerOnlineMark({ serverId, live }: { serverId: string; live: ClientLive }) {
  if (!live.ofServer(serverId).some((l) => l.state === 'online')) return null;
  return (
    <Chip tone="ok" dot pulse>
      на связи
    </Chip>
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
        <span className="text-xs text-muted">
          <Num value={v} format={rate} />
        </span>
      )}
    </>
  );
}
