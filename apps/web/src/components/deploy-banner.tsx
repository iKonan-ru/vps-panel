import { Button } from '@/components/ui/button';
import { Meter } from '@/components/ui/meter';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, X } from 'lucide-react';
import { useEffect, useState } from 'react';

export interface DeployStatus {
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
export interface DeployInfo {
  status: DeployStatus | null;
  bootedAt: string;
  /** Версия релиза (1.2.3, 1.3.0-beta.1); сборка из исходников - "dev". */
  version?: string;
  commit?: string;
}

const HIDDEN_KEY = 'vps-deploy-hidden';

/**
 * Обновление панели запрошено из Настроек: до первого шага службы на хосте (секунда-другая)
 * полоса показывает "запуск обновления", а не прошлый итог. Минута без ответа службы - забываем.
 */
let pending: DeployStatus | null = null;
export function markPanelUpdate(version: string, running: string | null): DeployStatus {
  const now = Math.floor(Date.now() / 1000);
  pending = {
    state: 'building',
    commit: version,
    running,
    startedAt: now,
    updatedAt: now,
    step: 0,
    total: 4,
    stepName: 'запуск обновления',
  };
  return pending;
}

/** Отчёт о выкладке и обновлении: пока идёт, опрашивается часто, иначе - редко. */
export function useDeploy() {
  return useQuery({
    queryKey: ['deploy'],
    queryFn: async () => {
      const d = await api<DeployInfo>('/api/deploy');
      const p = pending;
      if (p) {
        const fresh = (d.status?.startedAt ?? 0) >= p.startedAt - 5;
        if (fresh || Date.now() / 1000 - p.startedAt > 60) pending = null;
        else return { ...d, status: p };
      }
      return d;
    },
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
 * Полоса сверху о выкладке панели: ход сборки (пока собирается новая версия, работает старая)
 * и ошибка с хвостом лога. После удачного обновления страница перезагружается сама (useFreshCode).
 */
export function DeployBanner() {
  const { data } = useDeploy();
  useFreshCode();
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
  const st = data?.status ?? null;
  const building = st?.state === 'building';

  useEffect(() => {
    if (!building) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [building]);

  if (!data || !st || hidden === st.startedAt) return null;

  if (building) {
    const pct = Math.round((st.step / Math.max(1, st.total)) * 100);
    return (
      <Bar tone="accent">
        <RefreshCw className="size-4 shrink-0 animate-spin" />
        <div className="min-w-0 grow">
          <div>
            Обновление до {st.commit}: шаг {st.step} из {st.total}, {st.stepName},{' '}
            {mmss(Math.round(now / 1000) - st.startedAt)}
          </div>
          <Meter pct={pct} className="mt-1.5 h-1 bg-accent/20" fill="bg-accent" />
        </div>
      </Bar>
    );
  }
  if (st.state === 'failed' && Date.now() / 1000 - st.updatedAt < 24 * 3600) {
    return (
      <Bar tone="bad" onClose={() => hide(st.startedAt)}>
        <div className="min-w-0 grow">
          <div>
            Обновление до {st.commit} не удалось на шаге &laquo;{st.stepName}&raquo;, работает
            прежняя версия
            {st.running ? ` (${st.running})` : ''}
          </div>
          {st.tail && (
            <Button variant="link" className="text-xs" onClick={() => setShowLog(!showLog)}>
              {showLog ? 'Скрыть журнал' : 'Показать журнал'}
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
  return null;
}

/** Главный скрипт интерфейса в разметке (имя с хешем сборки): /assets/index-<хеш>.js. */
const mainScript = (html: string) => /\/assets\/index-[\w-]+\.js/.exec(html)?.[0] ?? null;

/**
 * Интерфейс в браузере старше панели (обновление панели, вкладка открыта до него): страница
 * перезагружается сама. Проверка - при открытии и при каждом перезапуске или смене версии
 * панели (/api/deploy): имя главного скрипта в свежем index.html не совпало с загруженным.
 * Пока идёт обновление, работает прежняя версия - проверка ждёт его конца.
 */
function useFreshCode() {
  const { data } = useDeploy();
  const building = data?.status?.state === 'building';
  const key = data ? `${data.bootedAt}|${data.version ?? ''}|${data.commit ?? ''}` : null;
  useEffect(() => {
    if (!key || building) return;
    const mine = mainScript(document.documentElement.innerHTML);
    if (!mine) return; // разработка (vite): сборки с хешем нет
    let cancelled = false;
    fetch('/', { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((html) => {
        const fresh = mainScript(html);
        if (cancelled || !fresh || fresh === mine) return;
        // от петли: один раз на каждую новую сборку
        try {
          if (sessionStorage.getItem(RELOAD_KEY) === fresh) return;
          sessionStorage.setItem(RELOAD_KEY, fresh);
        } catch {}
        location.reload();
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [key, building]);
}
const RELOAD_KEY = 'vps-reloaded-for';

/** Полоса над страницей: ход обновления панели и агентов, итог, ошибка. */
export function Bar({
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
