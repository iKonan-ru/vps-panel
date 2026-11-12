import { MetricCard } from '@/components/server/metric-card';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { LoadState } from '@/components/ui/placeholder';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago, bytes } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type {
  ConnAddrView,
  ConnAwgView,
  ConnKind,
  ConnPortSummary,
  ConnUser,
  ConnsView,
  ServerDetail,
} from '@vps/protocol';
import { ArrowDown, ArrowUp, Ban, ExternalLink, ShieldOff } from 'lucide-react';
import { type ReactNode, useState } from 'react';

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

const linkCls = 'text-accent hover:underline';

/** Сортировка списка: ключ и направление; повторное нажатие на ключ меняет направление. */
function useSort<K extends string>(initial: K, desc: boolean) {
  const [sort, setSort] = useState<{ key: K; desc: boolean }>({ key: initial, desc });
  const toggle = (key: K, firstDesc: boolean) =>
    setSort((s) => (s.key === key ? { key, desc: !s.desc } : { key, desc: firstDesc }));
  return { sort, toggle };
}

/** Кнопки сортировки: активная показывает направление. */
function SortBar<K extends string>({
  options,
  sort,
  onSort,
}: {
  options: { key: K; title: string; desc: boolean }[];
  sort: { key: K; desc: boolean };
  onSort: (key: K, firstDesc: boolean) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 py-2.5 text-xs">
      <span className="text-muted">Сортировка:</span>
      {options.map((o) => {
        const on = sort.key === o.key;
        return (
          <button
            key={o.key}
            type="button"
            aria-pressed={on}
            onClick={() => onSort(o.key, o.desc)}
            className={cn(
              'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 transition-colors',
              on ? 'bg-accent text-white' : 'bg-surface-2 text-muted hover:text-text',
            )}
          >
            {o.title}
            {on && (sort.desc ? <ArrowDown className="size-3" /> : <ArrowUp className="size-3" />)}
          </button>
        );
      })}
    </div>
  );
}

const cmp = (a: string | number, b: string | number) =>
  typeof a === 'number' && typeof b === 'number'
    ? a - b
    : String(a).localeCompare(String(b), 'ru', { numeric: true });

function sorted<T>(
  list: T[],
  key: (x: T) => string | number,
  desc: boolean,
  tie: (x: T) => string,
) {
  return [...list].sort((a, b) => (desc ? -1 : 1) * cmp(key(a), key(b)) || cmp(tie(a), tie(b)));
}

/** Имя пользователя xray: клиент и вход каскада - ссылкой на карточку или сервер. */
function UserName({ u }: { u: ConnUser }) {
  if (u.clientId)
    return (
      <Link to="/clients/$id" params={{ id: u.clientId }} className={linkCls}>
        {u.name}
      </Link>
    );
  if (u.serverId)
    return (
      <Link to="/servers/$id" params={{ id: u.serverId }} className={linkCls}>
        {u.name}
      </Link>
    );
  return <>{u.name}</>;
}

function AddrName({ a }: { a: ConnAddrView }): ReactNode {
  if (!a.name && a.guess?.length) {
    const names = [...new Map(a.guess.map((g) => [g.clientId, g.name])).entries()];
    return (
      <span title="Предположительно: адрес недавно был у этого клиента">
        <span className="text-muted">вероятно, </span>
        {names.map(([id, name], i) => (
          <span key={id}>
            {i > 0 && ', '}
            <Link to="/clients/$id" params={{ id }} className={cn(linkCls, 'font-medium')}>
              {name}
            </Link>
          </span>
        ))}
      </span>
    );
  }
  if (!a.name) return null;
  if (a.clientId)
    return (
      <Link to="/clients/$id" params={{ id: a.clientId }} className={cn(linkCls, 'font-medium')}>
        {a.name}
      </Link>
    );
  if (a.serverId)
    return (
      <Link to="/servers/$id" params={{ id: a.serverId }} className={cn(linkCls, 'font-medium')}>
        {a.name}
      </Link>
    );
  return <span className="font-medium">{a.name}</span>;
}

function AddrRow({
  a,
  note,
  busy,
  onBlock,
}: {
  a: ConnAddrView;
  note?: string | undefined;
  busy: boolean;
  onBlock: (ip: string) => void;
}) {
  const k = KINDS[a.kind];
  return (
    <div className="flex flex-col gap-1.5 border-b border-border px-4 py-3 text-[13px] last:border-b-0">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <span className="font-mono select-all">{a.ip}</span>
        <Chip tone={k.tone}>{k.title}</Chip>
        <AddrName a={a} />
        <div className="grow" />
        <span className="tabular-nums">
          {a.conns}
          <span className="text-xs text-muted"> соед.</span>
        </span>
      </div>
      <div className="text-xs text-muted">{a.note}</div>
      {a.guess && a.guess.length > 0 && (
        <div className="text-xs text-muted">
          Адрес был у клиентов:{' '}
          {a.guess.map((g, i) => (
            <span key={`${g.clientId}-${g.serverId}`}>
              {i > 0 && '; '}
              <Link to="/clients/$id" params={{ id: g.clientId }} className={linkCls}>
                {g.name}
              </Link>{' '}
              на{' '}
              <Link
                to="/servers/$id/$tab"
                params={{ id: g.serverId, tab: 'conns' }}
                className={linkCls}
              >
                {g.serverName}
              </Link>
              , {ago(g.at)}
            </span>
          ))}
        </div>
      )}
      {a.users.length > 1 && a.kind !== 'cascade' && (
        <div className="text-xs text-muted">
          Пользователи с этим адресом:{' '}
          {a.users.map((u, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: порядок пользователей не меняется
            <span key={i}>
              {i > 0 && ', '}
              <UserName u={u} />
            </span>
          ))}
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
      {a.kind === 'unknown' && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-0.5">
          <Button
            size="sm"
            variant="danger"
            disabled={busy}
            title="Запретить все порты с этого адреса и сбросить его соединения"
            onClick={() => onBlock(a.ip)}
          >
            <Ban className="size-3.5" />
            Заблокировать
          </Button>
          <a
            href={`https://bgp.he.net/ip/${encodeURIComponent(a.ip)}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-accent hover:underline"
            title="Откроется сторонний сайт: чей это адрес"
          >
            Чей адрес <ExternalLink className="size-3" />
          </a>
          {note && <span className="text-xs text-ok">{note}</span>}
        </div>
      )}
    </div>
  );
}

function AwgRow({ p }: { p: ConnAwgView }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0">
      <span className="font-mono select-all">{p.ip || '-'}</span>
      <Chip tone={p.kind === 'client' ? 'accent' : 'warn'}>
        {p.kind === 'client' ? 'клиент' : 'не опознан'}
      </Chip>
      <span className="min-w-0 grow font-medium">
        {p.clientId ? (
          <Link to="/clients/$id" params={{ id: p.clientId }} className={linkCls}>
            {p.name}
          </Link>
        ) : (
          p.name
        )}
      </span>
      <span className="text-xs text-muted">
        handshake {ago(p.handshakeAt)}, от клиента {bytes(p.rx)}, к клиенту {bytes(p.tx)}
      </span>
    </div>
  );
}

/** Правило "Своих правил" firewall: запрет всех портов с адреса - так блокирует эта вкладка. */
interface FwRule {
  id: string;
  portFrom: number;
  portTo: number;
  source: string;
  action: string;
  comment: string;
  createdAt: string;
}
const isBlock = (r: FwRule) =>
  r.action === 'deny' && r.portFrom === 1 && r.portTo === 65535 && r.source !== 'any';

type AddrSort = 'conns' | 'ip' | 'name' | 'kind';
type AwgSort = 'name' | 'handshake' | 'traffic' | 'ip';
type PortSort = 'port' | 'conns' | 'ips';

/**
 * Подключения сервера сейчас: адреса с подписью (клиент, вход каскада, сервер, не опознан), пиры
 * AWG и порты сервисов. Данные - с агента, обновляются раз в 5 секунд; списки сортируются вручную.
 */
export function ConnsTab({ s }: { s: ServerDetail }) {
  const online = s.status === 'online';
  const qc = useQueryClient();
  const ask = useConfirm();
  const op = useAction();
  const [filter, setFilter] = useState<ConnKind | 'all'>('all');
  const [blocked, setBlocked] = useState<Record<string, string>>({});
  const addrSort = useSort<AddrSort>('conns', true);
  const awgSort = useSort<AwgSort>('name', false);
  const portSort = useSort<PortSort>('port', false);
  const { data, error, isLoading } = useQuery({
    queryKey: ['servers', s.id, 'connections'],
    queryFn: () => api<ConnsView>(`/api/servers/${s.id}/connections`),
    enabled: online,
    refetchInterval: 5_000,
  });
  const rules = useQuery({
    queryKey: ['fw-rules', s.id],
    queryFn: () => api<FwRule[]>(`/api/servers/${s.id}/firewall/rules`),
    enabled: online,
  });
  if (!online) return <LoadState offline />;
  if (isLoading || (error && !data)) return <LoadState error={error} />;
  if (!data) return null;
  const blockedList = (rules.data ?? []).filter(isBlock);

  async function unblock(r: FwRule) {
    const ok = await ask({
      title: `Снять блокировку ${r.source}?`,
      text: 'Адрес снова сможет подключаться ко всем портам сервера.',
      okLabel: 'Снять блокировку',
    });
    if (!ok) return;
    await op.run(async () => {
      await api(`/api/servers/${s.id}/firewall/rules/${r.id}`, { method: 'DELETE' });
      await qc.invalidateQueries({ queryKey: ['fw-rules', s.id] });
      await qc.invalidateQueries({ queryKey: ['servers', s.id, 'connections'] });
    });
  }

  async function block(ip: string) {
    const ok = await ask({
      title: `Заблокировать ${ip}?`,
      text: (
        <>
          С этого адреса закроются все порты сервера, а его текущие соединения будут сброшены.
          Правило появится во вкладке Firewall, в &laquo;Своих правилах&raquo;, и снимается там же.
          Если за адресом несколько человек (мобильная сеть, офис), они тоже потеряют доступ.
        </>
      ),
      okLabel: 'Заблокировать',
      danger: true,
    });
    if (!ok) return;
    await op.run(async () => {
      const r = await api<{ before: number | null; after: number | null }>(
        `/api/servers/${s.id}/connections/block`,
        { method: 'POST', json: { ip } },
      );
      setBlocked((b) => ({
        ...b,
        [ip]:
          r.before === null
            ? 'заблокирован'
            : r.after === 0
              ? `заблокирован, сброшено соединений: ${r.before}`
              : `заблокирован, но ${r.after} из ${r.before} соединений остались: закроются сами`,
      }));
      await qc.invalidateQueries({ queryKey: ['servers', s.id, 'connections'] });
    });
  }

  const count = (k: ConnKind | 'all') =>
    k === 'all' ? data.addrs.length : data.addrs.filter((a) => a.kind === k).length;
  const addrKey: Record<AddrSort, (a: ConnAddrView) => string | number> = {
    conns: (a) => a.conns,
    ip: (a) => a.ip,
    name: (a) => a.name ?? a.guess?.[0]?.name ?? '',
    kind: (a) => a.kind,
  };
  const addrs = sorted(
    data.addrs.filter((a) => filter === 'all' || a.kind === filter),
    addrKey[addrSort.sort.key],
    addrSort.sort.desc,
    (a) => a.ip,
  );
  const awgKey: Record<AwgSort, (p: ConnAwgView) => string | number> = {
    name: (p) => p.name,
    handshake: (p) => p.handshakeAt,
    traffic: (p) => p.rx + p.tx,
    ip: (p) => p.ip,
  };
  const awg = sorted(data.awg, awgKey[awgSort.sort.key], awgSort.sort.desc, (p) => p.ip);
  const portKey: Record<PortSort, (p: ConnPortSummary) => string | number> = {
    port: (p) => p.port,
    conns: (p) => p.conns,
    ips: (p) => p.ips,
  };
  const ports = sorted(data.ports, portKey[portSort.sort.key], portSort.sort.desc, (p) =>
    String(p.port).padStart(5, '0'),
  );

  return (
    <div className="flex flex-col gap-4">
      {error && <Alert tone="bad">{error.message}</Alert>}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
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
        <div className="border-b border-border">
          <SortBar
            sort={addrSort.sort}
            onSort={addrSort.toggle}
            options={[
              { key: 'conns', title: 'Соединения', desc: true },
              { key: 'ip', title: 'Адрес', desc: false },
              { key: 'name', title: 'Имя', desc: false },
              { key: 'kind', title: 'Тип', desc: false },
            ]}
          />
        </div>
        {addrs.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">Подключений нет</div>
        )}
        {addrs.map((a) => (
          <AddrRow key={a.ip} a={a} note={blocked[a.ip]} busy={op.busy} onBlock={block} />
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
          <div className="border-b border-border">
            <SortBar
              sort={awgSort.sort}
              onSort={awgSort.toggle}
              options={[
                { key: 'name', title: 'Имя', desc: false },
                { key: 'handshake', title: 'Handshake', desc: true },
                { key: 'traffic', title: 'Трафик', desc: true },
                { key: 'ip', title: 'Адрес', desc: false },
              ]}
            />
          </div>
          {awg.map((p) => (
            <AwgRow key={`${p.name}-${p.ip}-${p.handshakeAt}`} p={p} />
          ))}
        </Section>
      )}

      {blockedList.length > 0 && (
        <Section
          title="Заблокированные адреса"
          info="Блокировка постоянная: правило ufw остаётся, пока его не снять. Те же правила видны во вкладке Firewall, в &laquo;Своих правилах&raquo;"
        >
          {blockedList.map((r) => (
            <div
              key={r.id}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
            >
              <span className="font-mono select-all">{r.source}</span>
              <span className="min-w-0 grow text-xs text-muted">
                заблокирован {ago(r.createdAt)}
                {r.comment && r.comment !== 'Блокировка из подключений' ? `: ${r.comment}` : ''}
              </span>
              <Button size="sm" disabled={op.busy} onClick={() => void unblock(r)}>
                <ShieldOff className="size-3.5" />
                Снять блокировку
              </Button>
            </div>
          ))}
        </Section>
      )}

      <Section
        title="Порты"
        info="Внешние TCP-порты сервисов и сколько соединений и адресов на каждом. HTTP-транспорты (XHTTP) открывают много параллельных соединений даже от одного клиента"
      >
        {data.ports.length > 1 && (
          <div className="border-b border-border">
            <SortBar
              sort={portSort.sort}
              onSort={portSort.toggle}
              options={[
                { key: 'port', title: 'Порт', desc: false },
                { key: 'conns', title: 'Соединения', desc: true },
                { key: 'ips', title: 'Адреса', desc: true },
              ]}
            />
          </div>
        )}
        {ports.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">Внешних портов сервисов нет</div>
        )}
        {ports.map((p) => (
          // число соединений и адресов - всегда справа в одну строку, переносится только описание
          <div
            key={p.port}
            className="flex items-start gap-3 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
          >
            <div className="min-w-0 grow">
              <span className="font-mono">{p.port}</span>{' '}
              <span className="text-muted">
                {[p.label, p.process].filter(Boolean).join(', ') || 'процесс не определён'}
              </span>
            </div>
            <span className="shrink-0 whitespace-nowrap tabular-nums">
              {p.conns}
              <span className="text-xs text-muted"> соед., </span>
              {p.ips}
              <span className="text-xs text-muted"> адр.</span>
            </span>
          </div>
        ))}
      </Section>
    </div>
  );
}
