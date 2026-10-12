import { Button } from '@/components/ui/button';
import { Meter } from '@/components/ui/meter';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

interface DeployStatus {
  state: 'building' | 'done' | 'failed';
  commit: string;
  running: string | null;
  startedAt: number;
  updatedAt: number;
  step: number;
  total: number;
  stepName: string;
  tail?: string[];
}
interface DeployInfo {
  status: DeployStatus | null;
  bootedAt: string;
  /** Версия релиза (1.2.3, 1.3.0-beta.1); сборка из исходников - "dev". */
  version?: string;
  commit?: string;
}

const HIDDEN_KEY = 'vps-deploy-hidden';

/** Отчёт о выкладке (deploy/build.py): во время сборки опрашивается часто, иначе - редко. */
function useDeploy() {
  return useQuery({
    queryKey: ['deploy'],
    queryFn: () => api<DeployInfo>('/api/deploy'),
    refetchInterval: (q) => (q.state.data?.status?.state === 'building' ? 3000 : 30_000),
    retry: false,
  });
}

/** Версия работающей панели: релиз, иначе коммит последней удачной выкладки. */
export function usePanelVersion(): string | null {
  const { data } = useDeploy();
  if (data?.version && data.version !== 'dev') return data.version;
  return data?.status?.running ?? null;
}

const mmss = (sec: number) =>
  `${Math.floor(sec / 60)}:${String(Math.max(0, sec % 60)).padStart(2, '0')}`;

/**
 * Полоса сверху о выкладке панели: ход сборки (пока собирается новая версия, работает старая),
 * ошибка сборки с хвостом лога, "панель обновлена" после перезапуска - с кнопкой обновить.
 */
export function DeployBanner() {
  const { data } = useDeploy();
  const firstBoot = useRef<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // закрытую полосу помним в браузере, иначе "сборка упала" вернётся после перезагрузки
  const [hidden, setHidden] = useState<number | null>(() => {
    try {
      return Number(localStorage.getItem(HIDDEN_KEY)) || null;
    } catch {
      return null;
    }
  });
  const hide = (startedAt: number) => {
    setHidden(startedAt);
    try {
      localStorage.setItem(HIDDEN_KEY, String(startedAt));
    } catch {}
  };
  const [showLog, setShowLog] = useState(false);
  if (data && firstBoot.current === null) firstBoot.current = data.bootedAt;
  const st = data?.status ?? null;
  const building = st?.state === 'building';

  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [building]);

  if (!data || !st || hidden === st.startedAt) return null;
  const restarted = firstBoot.current !== null && data.bootedAt !== firstBoot.current;
  const took = mmss(st.updatedAt - st.startedAt);

  if (building) {
    const pct = Math.round((st.step / Math.max(1, st.total)) * 100);
    return (
      <Bar tone="accent">
        <RefreshCw className="size-4 shrink-0 animate-spin" />
        <div className="min-w-0 grow">
          <div>
            Панель обновляется до {st.commit}: шаг {st.step} из {st.total}, {st.stepName},{' '}
            {mmss(Math.round(now / 1000) - st.startedAt)}
          </div>
          <Meter pct={pct} className="mt-1.5 h-1 bg-accent/20" fill="bg-accent" />
          <div className="mt-1 text-xs opacity-80">
            Пока готовится новая версия, работает прежняя; после перезапуска здесь появится кнопка
            обновить страницу.
          </div>
        </div>
      </Bar>
    );
  }
  if (st.state === 'failed' && Date.now() / 1000 - st.updatedAt < 24 * 3600) {
    return (
      <Bar tone="bad" onClose={() => hide(st.startedAt)}>
        <div className="min-w-0 grow">
          <div>
            Обновление до {st.commit} не удалось на шаге "{st.stepName}" за {took}: работает прежняя
            версия
            {st.running ? ` (${st.running})` : ''}.
          </div>
          {st.tail && (
            <Button variant="link" className="text-xs" onClick={() => setShowLog(!showLog)}>
              {showLog ? 'Скрыть лог' : 'Показать конец лога'}
            </Button>
          )}
          {showLog && (
            <pre className="mt-2 max-h-[40vh] overflow-auto whitespace-pre-wrap console rounded-lg p-3 font-mono text-xs [overflow-wrap:anywhere]">
              {st.tail?.join('\n')}
            </pre>
          )}
        </div>
      </Bar>
    );
  }
  if (st.state === 'done' && restarted) {
    return (
      <Bar tone="ok" onClose={() => hide(st.startedAt)}>
        <div className="min-w-0 grow">
          Панель обновлена до {st.commit} (за {took}). Обнови страницу, чтобы загрузить новую версию
          интерфейса.
        </div>
        <Button
          size="sm"
          variant="primary"
          onClick={() => location.reload()}
          label="Обновить"
          short="Обновить"
        >
          <RefreshCw className="size-3.5" />
        </Button>
      </Bar>
    );
  }
  return null;
}

function Bar({
  tone,
  onClose,
  children,
}: { tone: 'accent' | 'bad' | 'ok'; onClose?: () => void; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl border px-4 py-3 text-[13px]',
        tone === 'accent' && 'border-accent/40 bg-accent/10 text-accent',
        tone === 'bad' && 'border-bad/40 bg-bad/10 text-bad',
        tone === 'ok' && 'items-center border-ok/40 bg-ok/10 text-ok',
      )}
    >
      {children}
      {onClose && (
        <Button size="icon-sm" variant="ghost" aria-label="Скрыть" onClick={onClose}>
          <X className="size-3.5" />
        </Button>
      )}
    </div>
  );
}
