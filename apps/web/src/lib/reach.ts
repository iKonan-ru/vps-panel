import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';

/** Доступность из России (lib/ru-reach.ts на сервере). */
export interface ReachTarget {
  key: string;
  title: string;
  kind: 'tcp' | 'tls';
  port: number;
  sni?: string;
  percent: number | null;
  total: number;
  ok: number;
  errors: string[];
  error?: string;
  checkedAt: string | null;
  /** Медиана задержки последней проверки, мс (нет у MTProxyL и у старых агентов). */
  rtt?: number;
  history: { at: string; percent: number; total: number; rtt?: number }[];
  source: 'agent' | 'mtproxyl';
}

export interface ServerReach {
  checkedAt: string | null;
  error?: string;
  remaining?: number;
  targets: ReachTarget[];
}

/** Зонд проверки: город, сеть и её AS, дошёл ли. */
export interface ReachProbe {
  city: string;
  asn: number;
  network: string;
  ok: boolean;
  error?: string;
  /** Задержка дошедшего зонда, мс. */
  rtt?: number;
}

export type ReachPoint = ReachTarget['history'][number];

/**
 * Общая шкала графиков: получасовые интервалы по часам. Проверки агента - в :00 и :30 и
 * относятся к интервалу, который ими заканчивается (3 минуты запаса на саму проверку); MTProxyL
 * проверяет себя чаще и в своё время - его проверки попадают в те же интервалы. Поэтому графики
 * всех целей заканчиваются одним и тем же интервалом и совпадают по времени.
 */
export const SLOT_MS = 30 * 60_000;
const GRACE_MS = 3 * 60_000;
export const SLOTS = 24;

export interface ReachSlot {
  /** Конец интервала (время проверки агента). */
  end: number;
  /** Проверки интервала, новые первыми. */
  points: ReachPoint[];
  /** Худшая проверка интервала; null - проверок не было. */
  percent: number | null;
  /** Медиана задержки проверок интервала, мс; null - не мерили. */
  rtt: number | null;
  /** Интервал ещё идёт. */
  current: boolean;
}

/** Интервалы истории: последние SLOTS законченных; current - и текущий, если в нём уже есть проверки. */
export function reachSlots(history: ReachPoint[], now: number, current = false): ReachSlot[] {
  const last = Math.floor((now - GRACE_MS) / SLOT_MS);
  const by = new Map<number, ReachPoint[]>();
  for (const p of history) {
    const k = Math.floor((Date.parse(p.at) - GRACE_MS) / SLOT_MS) + 1;
    by.set(k, [p, ...(by.get(k) ?? [])]);
  }
  const out: ReachSlot[] = [];
  for (let k = last - SLOTS + 1; k <= last + 1; k++) {
    const points = by.get(k) ?? [];
    if (k > last && (!current || points.length === 0)) continue;
    out.push({
      end: k * SLOT_MS,
      points,
      percent: points.length ? Math.min(...points.map((p) => p.percent)) : null,
      rtt: median(points.flatMap((p) => (p.rtt ? [p.rtt] : []))),
      current: k > last,
    });
  }
  return out;
}

/** Медиана; null - значений нет. */
export function median(v: number[]): number | null {
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  const h = Math.floor(s.length / 2);
  return s.length % 2 ? (s[h] ?? null) : ((s[h - 1] ?? 0) + (s[h] ?? 0)) / 2;
}

/** Задержка: 46 мс. */
export function ms(v: number): string {
  return `${Math.round(v)}\u00a0мс`;
}

/**
 * Задержка до сервера из России: у адреса сервера (TCP до SSH), иначе медиана по целям с
 * задержкой; null - не мерили.
 */
export function serverRtt(r: ServerReach | undefined | null): number | null {
  if (!r) return null;
  const ip = r.targets.find((t) => t.key === 'ip')?.rtt;
  if (ip) return ip;
  return median(r.targets.flatMap((t) => (t.rtt ? [t.rtt] : [])));
}

export function useReachProbes(serverId: string, key: string | null) {
  return useQuery({
    queryKey: ['reach-probes', serverId, key],
    queryFn: () =>
      api<{ at: string; probes: ReachProbe[] }[]>(
        `/api/servers/${serverId}/reach/probes?key=${encodeURIComponent(key ?? '')}`,
      ),
    enabled: key !== null,
    staleTime: 60_000,
  });
}

export type ReachLevel = 'ok' | 'partial' | 'bad';

/** Как у MTProxyL: от 80% - видно, от 50% - частично, ниже - не видно. */
export function reachLevel(percent: number | null): ReachLevel | null {
  if (percent === null) return null;
  return percent >= 80 ? 'ok' : percent >= 50 ? 'partial' : 'bad';
}

export const reachTone = { ok: 'ok', partial: 'warn', bad: 'bad' } as const;

/** Итоги по всем серверам: одна выборка на страницу серверов. */
export function useReachAll() {
  return useQuery({
    queryKey: ['reach'],
    queryFn: () => api<Record<string, ServerReach>>('/api/reach'),
    refetchInterval: 5 * 60_000,
  });
}

export function useServerReach(serverId: string) {
  return useQuery({
    queryKey: ['reach', serverId],
    queryFn: () => api<ServerReach | null>(`/api/servers/${serverId}/reach`),
    refetchInterval: 5 * 60_000,
  });
}
