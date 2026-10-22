import { ServerStatusChip } from '@/components/server-status';
import { AttentionChips } from '@/components/servers/attention';
import { ServerTags } from '@/components/servers/server-tags';
import { ServiceChips } from '@/components/service-chips';
import { Bar } from '@/components/ui/bar';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { countryLabel } from '@/lib/countries';
import { dateShort, daysUntil, money, paymentSoon, uptime } from '@/lib/format';
import { ms, serverRtt, useReachAll } from '@/lib/reach';
import { Link, useNavigate } from '@tanstack/react-router';
import type { ServerSummary } from '@vps/protocol';

/** Задержка из России: "из РФ 46 мс". */
function RuRtt({ s, short = false }: { s: ServerSummary; short?: boolean }) {
  const { data: reach } = useReachAll();
  const rtt = serverRtt(reach?.[s.id]);
  if (rtt === null) return null;
  return (
    <span
      className="whitespace-nowrap tabular-nums"
      title="Задержка из домашних сетей России: медиана по зондам Globalping последней проверки"
    >
      {short ? 'РФ' : 'из РФ'} {ms(rtt)}
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

/** Фильтр списка по тегу: выбранный тег и выбор по клику на плашку. */
interface TagFilter {
  tag?: string | undefined;
  onTag?: (tag: string) => void;
}

/** Строка таблицы серверов (широкий экран); i - номер строки для каскада появления. */
export function ServerRow({ s, i = 0, tag, onTag }: { s: ServerSummary; i?: number } & TagFilter) {
  const navigate = useNavigate();
  const open = () => navigate({ to: '/servers/$id', params: { id: s.id } });
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиатурный путь - ссылка на имени сервера внутри строки
    <tr
      onClick={(e) => {
        // клик по ссылке или кнопке внутри строки обрабатывают они сами
        if ((e.target as HTMLElement).closest('a, button')) return;
        void open();
      }}
      style={{ '--i': i } as React.CSSProperties}
      className="stagger animate-rise cursor-pointer transition-colors duration-150 hover:bg-surface-2 [&>td]:border-b [&>td]:border-border [&>td]:px-3 [&>td]:py-2.5 [&>td]:align-middle"
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
        <ServerTags tags={s.tags} onPick={onTag} active={tag} className="mt-1.5" />
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
        <div className="mt-0.5 text-xs text-muted empty:hidden">
          <RuRtt s={s} />
        </div>
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

/** Плашка сервера, на котором стоит сама панель. */
function PanelHostChip() {
  return (
    <Chip tone="accent" className="font-sans" title="Сервер панели">
      панель
    </Chip>
  );
}

/** Карточка сервера в списке на узком экране. */
export function ServerCard({ s, i = 0, tag, onTag }: { s: ServerSummary; i?: number } & TagFilter) {
  const navigate = useNavigate();
  return (
    // не ссылка целиком: внутри - ссылки на панели сервисов, вложенная ссылка уводила бы на
    // карточку сервера; клавиатурный путь - ссылка на имени
    // biome-ignore lint/a11y/useKeyWithClickEvents: клавиатурный путь - ссылка на имени сервера
    <div
      style={{ '--i': i } as React.CSSProperties}
      className="stagger animate-rise cursor-pointer"
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('a, button')) return;
        void navigate({ to: '/servers/$id', params: { id: s.id } });
      }}
    >
      <Card className="flex flex-col gap-2 p-3.5 transition-[border-color,scale] duration-150 hover:border-accent active:scale-[0.99]">
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
          <div className="flex flex-wrap gap-x-2.5 gap-y-0.5 text-xs text-muted">
            <span>CPU {Math.round(s.metrics.cpuPercent)}%</span>
            <span>
              RAM {Math.round((s.metrics.memUsedMb / Math.max(1, s.metrics.memTotalMb)) * 100)}%
            </span>
            <span>
              Диск {Math.round((s.metrics.diskUsedGb / Math.max(1, s.metrics.diskTotalGb)) * 100)}%
            </span>
            <RuRtt s={s} short />
          </div>
        )}
        <ServerTags tags={s.tags} onPick={onTag} active={tag} />
        <div className="flex flex-wrap items-center gap-1.5">
          <ServiceChips services={s.services} links={s.panelLinks} max={3} />
        </div>
        <AttentionChips s={s} mobile />
      </Card>
    </div>
  );
}
