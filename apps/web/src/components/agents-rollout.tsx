import { Bar } from '@/components/deploy-banner';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Meter } from '@/components/ui/meter';
import { api } from '@/lib/api';
import { subscribe } from '@/lib/live';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { RefreshCw } from 'lucide-react';
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

/** Обновление устаревших агентов: кнопка для шапки и полоса хода; по очереди до первой ошибки. */
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
      title: `Обновить агенты (серверов: ${outdated})?`,
      text: 'Серверы обновляются по очереди. Первая ошибка останавливает обновление.',
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
          className="rounded-full hover:brightness-125"
        >
          <Chip tone="warn">
            <RefreshCw className="size-3" />
            обновить агенты: {outdated}
          </Chip>
        </button>
      ) : null,
    card: error ? (
      <Bar tone="bad" onClose={() => setError(null)}>
        <div className="min-w-0 grow">Обновление агентов не запущено: {error}</div>
      </Bar>
    ) : rollout && hidden !== rollout.startedAt && !stale ? (
      <RolloutBar rollout={rollout} onClose={() => hide(rollout.startedAt)} />
    ) : null,
  };
}

/** Ход обновления агентов полосой: шкала по серверам, текущий сервер и итог. */
function RolloutBar({ rollout, onClose }: { rollout: Rollout; onClose: () => void }) {
  const total = rollout.items.length;
  const done = rollout.items.filter((i) => i.status !== 'pending' && i.status !== 'running').length;
  const failed = rollout.items.find((i) => i.status === 'error');
  const server = (it: RolloutItem) => (
    <Link to="/servers/$id" params={{ id: it.serverId }} className="font-medium underline">
      {it.name}
    </Link>
  );
  if (!rollout.finishedAt) {
    const current = rollout.items.find((i) => i.status === 'running');
    return (
      <Bar tone="accent">
        <RefreshCw className="size-4 shrink-0 animate-spin" />
        <div className="min-w-0 grow">
          <div>
            Обновление агентов: {Math.min(done + 1, total)} из {total}
            {current && <>, {server(current)}</>}
          </div>
          <Meter
            pct={Math.round((done / Math.max(1, total)) * 100)}
            className="mt-1.5 h-1 bg-accent/20"
            fill="bg-accent"
          />
        </div>
      </Bar>
    );
  }
  if (failed)
    return (
      <Bar tone="bad" onClose={onClose}>
        <div className="min-w-0 grow">
          Обновление агентов остановлено на {server(failed)}
          {failed.note ? `: ${failed.note}` : ''}
        </div>
      </Bar>
    );
  const ok = rollout.items.filter((i) => i.status === 'ok').length;
  return (
    <Bar tone="ok" onClose={onClose}>
      <div className="min-w-0 grow">
        Агенты обновлены: {ok} из {total}
      </div>
    </Bar>
  );
}
