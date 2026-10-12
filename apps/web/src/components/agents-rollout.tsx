import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/live';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

interface RolloutItem {
  serverId: string;
  name: string;
  status: 'pending' | 'running' | 'ok' | 'skipped' | 'error';
  note: string;
}
interface Rollout {
  startedAt: string;
  finishedAt: string | null;
  items: RolloutItem[];
}

const statusChip: Record<
  RolloutItem['status'],
  { tone: 'muted' | 'accent' | 'ok' | 'bad'; text: string }
> = {
  pending: { tone: 'muted', text: 'в очереди' },
  running: { tone: 'accent', text: 'обновляется' },
  ok: { tone: 'ok', text: 'обновлён' },
  skipped: { tone: 'muted', text: 'пропущен' },
  error: { tone: 'bad', text: 'ошибка' },
};

const HIDDEN_KEY = 'vps-agents-rollout-hidden';

/** Состояние раскатки агентов; меняется по событию agents.rollout. */
function useRollout() {
  const qc = useQueryClient();
  useEffect(
    () =>
      subscribe((ev) => {
        if (ev.type === 'agents.rollout')
          void qc.invalidateQueries({ queryKey: ['agents-rollout'] });
      }),
    [qc],
  );
  return useQuery({
    queryKey: ['agents-rollout'],
    queryFn: () => api<Rollout | null>('/api/agents/rollout'),
  });
}

/**
 * Обновление агентов на всех серверах с устаревшей версией: кнопка (для шапки страницы) и
 * карточка хода раскатки. Панель обновляет серверы по очереди и останавливается на первой
 * ошибке (см. routes/agent-update.ts).
 */
export function useAgentsRollout(outdated: number) {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: rollout } = useRollout();
  // закрытую раскатку помним в браузере: сервер держит последнюю до своего перезапуска
  const [hidden, setHidden] = useState<string | null>(() => {
    try {
      return localStorage.getItem(HIDDEN_KEY);
    } catch {
      return null;
    }
  });
  const hide = (startedAt: string) => {
    setHidden(startedAt);
    try {
      localStorage.setItem(HIDDEN_KEY, startedAt);
    } catch {}
  };
  // завершённая больше часа назад - уже не новость
  const stale =
    rollout?.finishedAt !== null &&
    rollout?.finishedAt !== undefined &&
    Date.now() - new Date(rollout.finishedAt).getTime() > 60 * 60_000;
  const [error, setError] = useState<string | null>(null);
  const running = Boolean(rollout && !rollout.finishedAt);

  // запуск раскатки: от подтверждения до свежего состояния кнопка недоступна
  const [starting, setStarting] = useState(false);
  async function start() {
    if (starting) return;
    const ok = await ask({
      title: `Обновить агентов на ${outdated} серверах?`,
      text: 'По очереди: следующий сервер - только когда агент предыдущего вернулся с новой версией. Первая ошибка останавливает раскатку.',
      okLabel: 'Обновить',
    });
    if (!ok) return;
    setError(null);
    setStarting(true);
    try {
      await api('/api/agents/rollout', { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['agents-rollout'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setStarting(false);
    }
  }

  return {
    // плашка в ряду счётчиков шапки: не раздвигает шапку, как отдельная кнопка
    button:
      outdated > 0 && !running ? (
        <button
          type="button"
          onClick={start}
          disabled={starting}
          title="Обновить агентов на всех серверах по очереди"
          className="rounded-full hover:brightness-125"
        >
          <Chip tone="warn">
            <RefreshCw className="size-3" />
            обновить агентов ({outdated})
          </Chip>
        </button>
      ) : null,
    card:
      error || (rollout && hidden !== rollout.startedAt && !stale) ? (
        <Section
          title="Обновление агентов"
          extra={
            rollout &&
            (running ? (
              <Chip tone="accent" dot pulse>
                идёт
              </Chip>
            ) : rollout.items.some((i) => i.status === 'error') ? (
              <Chip tone="bad">остановлено</Chip>
            ) : (
              <Chip tone="ok">завершено</Chip>
            ))
          }
          actions={
            rollout &&
            !running && (
              <Button size="sm" onClick={() => hide(rollout.startedAt)} label="Скрыть">
                <X className="size-3.5" />
              </Button>
            )
          }
        >
          {error && <div className="px-4 py-3 text-[13px] text-bad">{error}</div>}
          {rollout?.items.map((it) => (
            <div
              key={it.serverId}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 text-[13px] last:border-b-0"
            >
              <Link
                to="/servers/$id"
                params={{ id: it.serverId }}
                className="min-w-0 truncate font-medium hover:text-accent"
              >
                {it.name}
              </Link>
              <span className="min-w-0 grow truncate text-xs text-muted">{it.note}</span>
              <Chip tone={statusChip[it.status].tone} dot={it.status === 'running'}>
                {statusChip[it.status].text}
              </Chip>
            </div>
          ))}
        </Section>
      ) : null,
  };
}
