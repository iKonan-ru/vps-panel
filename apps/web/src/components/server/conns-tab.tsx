import { MetricCard } from '@/components/server/metric-card';
import { Alert } from '@/components/ui/alert';
import { Chip } from '@/components/ui/chip';
import { LoadState } from '@/components/ui/placeholder';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, bytes } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import type { ConnAddrView, ConnKind, ConnsView, ServerDetail } from '@vps/protocol';
import { useState } from 'react';

const KINDS: Record<ConnKind, { title: string; tone: 'accent' | 'update' | 'muted' | 'warn' }> = {
  client: { title: 'клиент', tone: 'accent' },
  cascade: { title: 'вход каскада', tone: 'update' },
  server: { title: 'сервер', tone: 'muted' },
  unknown: { title: 'не опознан', tone: 'warn' },
};
const FILTERS: { id: ConnKind | 'all'; title: string }[] = [
  { id: 'all', title: 'Все' },
  { id: 'client', title: 'Клиенты' },
  { id: 'cascade', title: 'Входы каскадов' },
  { id: 'server', title: 'Серверы' },
  { id: 'unknown', title: 'Не опознаны' },
];

function AddrRow({ a }: { a: ConnAddrView }) {
  const k = KINDS[a.kind];
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3 text-[13px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono select-all">{a.ip}</span>
        <Chip tone={k.tone}>{k.title}</Chip>
        {a.name && <span className="font-medium">{a.name}</span>}
        <div className="grow" />
        <span className="tabular-nums">
          {a.conns}
          <span className="text-xs text-muted"> соед.</span>
        </span>
      </div>
      <div className="text-xs text-muted">{a.note}</div>
      {a.users.length > 0 && a.kind !== 'cascade' && a.users.length > 1 && (
        <div className="text-xs text-muted">
          Пользователи с этим адресом: {a.users.map((u) => u.name).join(', ')}
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-muted">
        {a.ports.map((p) => (
          <span key={p.port} className="tabular-nums">
            порт <span className="font-mono text-text">{p.port}</span>
            {p.label && ` ${p.label}`}: {p.conns}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Подключения сервера сейчас: порты сервисов, адреса с подписью (клиент, вход каскада, сервер,
 * не опознан) и пиры AWG. Данные - с агента, обновляются раз в 5 секунд.
 */
export function ConnsTab({ s }: { s: ServerDetail }) {
  const online = s.status === 'online';
  const [filter, setFilter] = useState<ConnKind | 'all'>('all');
  const { data, error, isLoading } = useQuery({
    queryKey: ['servers', s.id, 'connections'],
    queryFn: () => api<ConnsView>(`/api/servers/${s.id}/connections`),
    enabled: online,
    refetchInterval: 5_000,
  });
  if (!online) return <LoadState offline />;
  if (isLoading || (error && !data)) return <LoadState error={error} />;
  if (!data) return null;
  const count = (k: ConnKind | 'all') =>
    k === 'all' ? data.addrs.length : data.addrs.filter((a) => a.kind === k).length;
  const shown = data.addrs.filter((a) => filter === 'all' || a.kind === filter);
  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="bad">{error.message}</Alert>}
      <div className="grid grid-cols-2 gap-3 md:gap-4 lg:grid-cols-3">
        <MetricCard
          label="Клиентов на связи"
          value={data.clients ?? '-'}
          note="VLESS, MTProxy, WDTT и AWG"
        />
        <MetricCard label="TCP-соединений" value={data.conns} note="к портам сервисов, без SSH" />
        <MetricCard label="Адресов" value={data.addresses} note="уникальных, без AWG" />
      </div>

      <Section
        title="Порты"
        info="Внешние TCP-порты сервисов и сколько соединений и адресов на каждом. HTTP-транспорты (XHTTP) открывают много параллельных соединений даже от одного клиента"
      >
        {data.ports.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">Внешних портов сервисов нет</div>
        )}
        {data.ports.map((p) => (
          <div
            key={p.port}
            className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
          >
            <span className="font-mono">{p.port}</span>
            <span className="min-w-0 grow text-muted">
              {[p.label, p.process].filter(Boolean).join(', ') || 'процесс не определён'}
            </span>
            <span className="tabular-nums">
              {p.conns}
              <span className="text-xs text-muted"> соед., </span>
              {p.ips}
              <span className="text-xs text-muted"> адр.</span>
            </span>
          </div>
        ))}
      </Section>

      <Section
        title="Адреса"
        info="Кто подключён: адрес клиента, вход каскада или сервер панели. За одним адресом (NAT, мобильная сеть) могут быть несколько человек, а у одного человека бывает несколько адресов"
        extra={<span className="text-xs text-muted">обновляется раз в 5&nbsp;с</span>}
      >
        <div className="flex flex-wrap gap-1.5 border-b border-border px-4 py-2.5">
          {FILTERS.filter((f) => f.id === 'all' || count(f.id) > 0).map((f) => (
            <button
              key={f.id}
              type="button"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs transition-colors',
                filter === f.id
                  ? 'bg-accent text-white'
                  : 'bg-surface-2 text-muted hover:text-text',
              )}
            >
              {f.title} <span className="tabular-nums">{count(f.id)}</span>
            </button>
          ))}
        </div>
        {shown.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">Подключений нет</div>
        )}
        {shown.map((a) => (
          <AddrRow key={a.ip} a={a} />
        ))}
        {data.truncated && (
          <div className="px-4 py-2.5 text-xs text-muted">
            Показаны самые нагруженные адреса, остальные не поместились
          </div>
        )}
      </Section>

      {(data.awg.length > 0 || data.errors.awg) && (
        <Section
          title="AWG"
          info="Пиры с handshake за последние 3 минуты (UDP): соединений как таковых нет"
        >
          {data.errors.awg && (
            <div className="px-4 py-3 text-[13px] text-bad">{data.errors.awg}</div>
          )}
          {data.awg.map((p) => (
            <div
              key={`${p.name}-${p.ip}`}
              className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
            >
              <span className="font-mono select-all">{p.ip || '-'}</span>
              <Chip tone={p.kind === 'client' ? 'accent' : 'warn'}>
                {p.kind === 'client' ? 'клиент' : 'не опознан'}
              </Chip>
              <span className="min-w-0 grow font-medium">{p.name}</span>
              <span className="text-xs text-muted">
                handshake {ago(p.handshakeAt)}, от клиента {bytes(p.rx)}, к клиенту {bytes(p.tx)}
              </span>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
