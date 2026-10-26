import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Meter } from '@/components/ui/meter';
import { Num } from '@/components/ui/num';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { GSyncState } from '@vps/protocol';
import { Square } from 'lucide-react';
import { useState } from 'react';

/** Состояние сверки: раз в 2 с, пока идёт, иначе раз в минуту (начало и конец - событием). */
export function useSyncState() {
  return useQuery({
    queryKey: ['gclients-syncing'],
    queryFn: () => api<GSyncState>('/api/gclients/syncing'),
    refetchInterval: (q) => (q.state.data?.syncing ? 2_000 : 60_000),
  });
}

/** Ход сверки по серверам; "Прервать" - серверы доделывают текущую операцию и останавливаются. */
export function SyncPanel() {
  const qc = useQueryClient();
  const { data } = useSyncState();
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!data?.syncing) return null;
  const total = data.progress.reduce((n, p) => n + p.total, 0);
  const done = data.progress.reduce((n, p) => n + p.done, 0);
  return (
    <Section
      className="animate-reveal"
      title="Синхронизация с серверами"
      info="Дольше всего заводятся каналы OpenFlux для новых устройств. Прерванное доделает следующая синхронизация: автоматическая раз в 5&nbsp;мин или по кнопке."
      extra={
        <>
          <Chip tone="accent" dot pulse>
            {data.stopping ? 'останавливается' : 'выполняется'}
          </Chip>
          {data.startedAt && (
            <span className="text-xs text-muted">начата {ago(data.startedAt)}</span>
          )}
          {total > 0 && (
            <span className="text-xs text-muted">
              записей <Num value={done} /> из {total}
            </span>
          )}
        </>
      }
      actions={
        <Button
          size="sm"
          variant="danger"
          disabled={data.stopping}
          onClick={async () => {
            setErr(null);
            try {
              await api('/api/gclients/sync/stop', { method: 'POST' });
              await qc.invalidateQueries({ queryKey: ['gclients-syncing'] });
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          label="Прервать"
          title="Каждый сервер закончит текущую операцию и остановится"
        >
          <Square className="size-3.5" />
        </Button>
      }
    >
      {err && (
        <div className="p-4 pb-0">
          <Alert tone="bad">{err}</Alert>
        </div>
      )}
      {data.progress.length === 0 && (
        <div className="px-4 py-3 text-[13px] text-muted">Подготовка&hellip;</div>
      )}
      {data.progress.map((p) => {
        const pct = p.total ? Math.round((p.done / p.total) * 100) : 100;
        return (
          // строки одного вида у всех серверов: имя, счётчик и плашки - первой строкой (имя
          // обрезается), полоса - второй, "сейчас" и "что сделано" (последние операции) - третьей
          <div key={p.server} className="border-b border-border px-4 py-2.5 last:border-b-0">
            <div className="flex min-w-0 items-center gap-2 text-[13px]">
              <span className="min-w-0 truncate font-medium" title={p.server}>
                {p.server}
              </span>
              <div className="grow" />
              <span className="shrink-0 font-mono text-xs text-muted">
                <Num value={p.done} />/{p.total}
              </span>
              {p.errors > 0 && <Chip tone="bad">ошибок {p.errors}</Chip>}
              {p.finished && <Chip tone="ok">готово</Chip>}
            </div>
            <Meter
              pct={pct}
              className="mt-1.5 h-1.5 w-full bg-track"
              fill={p.errors ? 'bg-warn' : 'bg-ok'}
            />
            {((!p.finished && p.current) || p.last.length > 0) && (
              <div className="mt-1 flex min-w-0 items-center gap-2 text-xs">
                <span className="min-w-0 grow truncate text-muted" title={p.current}>
                  {!p.finished && p.current ? `сейчас: ${p.current}` : ''}
                </span>
                {p.last.length > 0 && (
                  <Button
                    variant="link"
                    className="shrink-0 text-xs"
                    onClick={() => setOpen(open === p.server ? null : p.server)}
                  >
                    {open === p.server ? 'Скрыть' : 'Что сделано'}
                  </Button>
                )}
              </div>
            )}
            {open === p.server && (
              <ul className="mt-1 flex flex-col gap-0.5 font-mono text-[11px] text-muted">
                {p.last.map((l, i) => (
                  <li key={`${i}-${l}`} className={cn('break-all', /ошибка/.test(l) && 'text-bad')}>
                    {l}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </Section>
  );
}
