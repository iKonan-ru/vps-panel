import { useSyncState } from '@/components/clients/sync-panel';
import { Meter } from '@/components/ui/meter';
import { Link, useLocation } from '@tanstack/react-router';
import { ChevronRight, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';

/** Короткая сверка (одна правка клиента) полосу не показывает: появилась бы и сразу пропала. */
const SHOW_AFTER_MS = 3_000;

/** Полоса хода синхронизации клиентов; на странице клиентов не нужна - там своя панель хода. */
export function SyncBanner() {
  const { data } = useSyncState();
  const pathname = useLocation({ select: (l) => l.pathname });
  const syncing = Boolean(data?.syncing);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!syncing) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [syncing]);
  if (!data?.syncing || pathname === '/clients') return null;
  const started = data.startedAt ? Date.parse(data.startedAt) : now;
  if (now - started < SHOW_AFTER_MS) return null;
  const total = data.progress.reduce((n, p) => n + p.total, 0);
  const done = data.progress.reduce((n, p) => n + p.done, 0);
  const errors = data.progress.reduce((n, p) => n + p.errors, 0);
  return (
    <Link
      to="/clients"
      className="flex items-start gap-3 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3 text-[13px] text-accent transition-colors hover:bg-accent/15"
    >
      <RefreshCw className="mt-0.5 size-4 shrink-0 animate-spin" />
      <div className="min-w-0 grow">
        <div>
          {data.stopping ? 'Синхронизация клиентов останавливается' : 'Идёт синхронизация клиентов'}
          {total > 0 && `: ${done} из ${total}`}
          {errors > 0 && `, ошибок: ${errors}`}
        </div>
        {total > 0 && (
          <Meter
            pct={Math.round((done / total) * 100)}
            className="mt-1.5 h-1 bg-accent/20"
            fill="bg-accent"
          />
        )}
      </div>
      <ChevronRight className="mt-0.5 size-4 shrink-0" />
    </Link>
  );
}
