import { Logo } from '@/components/logo';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useParams } from '@tanstack/react-router';
import { serviceByKind } from '@vps/protocol';
import { Check, Circle, LoaderCircle, RotateCw, Server, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

/** Ответ POST /api/proxy/probe/<метка>, ProxyProbe сервера. */
interface Probe {
  ok: boolean;
  stage?: 'target' | 'agent' | 'tunnel' | 'panel';
  error?: string;
  serverId?: string;
  server?: string;
  kind?: 'xui' | 'mtproxyl';
  tunnelMs?: number;
  panelMs?: number;
}

/** Сколько раз проверять самим, прежде чем отдать решение человеку. */
const ATTEMPTS = 3;
const RETRY_MS = 2000;

const steps = [
  { stage: 'agent', title: 'Сервер в сети' },
  { stage: 'tunnel', title: 'Канал до панели сервиса' },
  { stage: 'panel', title: 'Панель отвечает' },
] as const;

type StepState = 'wait' | 'run' | 'ok' | 'fail';

/**
 * "Открываю панель" сервиса: проверка агента, канала до панели на сервере и её ответа (заодно канал
 * открывается для первых запросов браузера), затем переход на поддомен. Не вышло - причина, ещё
 * попытки, потом "Повторить" и переход в карточку сервера.
 */
export function OpenPanelPage() {
  const { label } = useParams({ strict: false }) as { label: string };
  const back = new URLSearchParams(location.search).get('back') ?? '';
  const kind = label.endsWith('-mtproxyl') ? 'mtproxyl' : 'xui';
  const [probe, setProbe] = useState<Probe | null>(null);
  const [running, setRunning] = useState(true);
  const [attempt, setAttempt] = useState(1);
  const [fatal, setFatal] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const openUrl = `/api/proxy/open/${encodeURIComponent(label)}`;
  const goUrl = `${openUrl}?go=1${back ? `&back=${encodeURIComponent(back)}` : ''}`;

  const run = useCallback(
    async (n: number) => {
      clearTimeout(timer.current);
      setAttempt(n);
      setRunning(true);
      setFatal(null);
      try {
        const p = await api<Probe>(`/api/proxy/probe/${encodeURIComponent(label)}`, {
          method: 'POST',
        });
        setProbe(p);
        setRunning(false);
        if (p.ok) {
          // короткая пауза: видно, что проверка прошла, а не что страница мигнула
          timer.current = setTimeout(() => location.replace(goUrl), 400);
        } else if (p.stage !== 'target' && n < ATTEMPTS) {
          timer.current = setTimeout(() => void run(n + 1), RETRY_MS);
        }
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          location.replace(
            `/login?next=${encodeURIComponent(openUrl + (back ? `?back=${encodeURIComponent(back)}` : ''))}`,
          );
          return;
        }
        setRunning(false);
        setFatal((e as Error).message);
      }
    },
    [label, goUrl, openUrl, back],
  );

  useEffect(() => {
    void run(1);
    return () => clearTimeout(timer.current);
  }, [run]);

  const title = serviceByKind(probe?.kind ?? kind)?.title ?? 'панели';
  useEffect(() => {
    document.title = `Открытие ${title}${probe?.server ? `\u00a0\u2014 ${probe.server}` : ''}`;
  }, [title, probe?.server]);

  const failIdx = probe && !probe.ok ? steps.findIndex((s) => s.stage === probe.stage) : -1;
  const state = (i: number): StepState => {
    if (running) return probe?.ok === false && i < failIdx ? 'ok' : 'run';
    if (!probe) return 'wait';
    if (probe.ok) return 'ok';
    if (failIdx < 0) return 'wait';
    return i < failIdx ? 'ok' : i === failIdx ? 'fail' : 'wait';
  };
  const time = (i: number) => {
    if (state(i) !== 'ok') return null;
    const ms = i === 1 ? probe?.tunnelMs : i === 2 ? probe?.panelMs : undefined;
    return ms === undefined ? null : `${ms}\u00a0мс`;
  };
  const retrying = !running && probe && !probe.ok && probe.stage !== 'target' && attempt < ATTEMPTS;
  const gaveUp = !running && ((probe && !probe.ok && !retrying) || fatal);

  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <Card className="flex w-full min-w-0 max-w-[420px] flex-col gap-5 p-6 md:p-8">
        <Logo size={28} />
        <div>
          <div className="text-xl font-semibold">Открытие {title}</div>
          <div className="mt-1 flex items-center gap-1.5 text-[13px] text-muted">
            <Server className="size-3.5" />
            {probe?.server || label}
          </div>
        </div>
        {probe?.stage !== 'target' && (
          <ol className="flex flex-col gap-3" aria-live="polite">
            {steps.map((s, i) => {
              const st = state(i);
              return (
                <li key={s.stage} className="flex items-center gap-2.5 text-sm">
                  <StepIcon state={st} />
                  <span className={cn(st === 'wait' && 'text-muted', st === 'fail' && 'text-bad')}>
                    {s.title}
                  </span>
                  <span className="grow" />
                  <span className="text-xs text-muted tabular-nums">{time(i)}</span>
                </li>
              );
            })}
          </ol>
        )}
        {probe?.ok && !running && (
          <div className="text-[13px] text-ok">Панель готова, переход&hellip;</div>
        )}
        {(probe?.error || fatal) && !running && (
          <Alert tone="bad">
            {probe?.error ?? fatal}
            {retrying && (
              <div className="mt-1 text-xs text-muted">
                Повтор через {RETRY_MS / 1000}&nbsp;с, попытка {attempt + 1} из {ATTEMPTS}
              </div>
            )}
          </Alert>
        )}
        {gaveUp && (
          <div className="flex flex-wrap gap-2">
            {probe?.stage !== 'target' && (
              <Button variant="primary" onClick={() => void run(1)}>
                <RotateCw className="size-4" />
                Повторить
              </Button>
            )}
            {probe?.serverId ? (
              <ButtonLink to="/servers/$id" params={{ id: probe.serverId }}>
                Открыть сервер
              </ButtonLink>
            ) : (
              <ButtonLink to="/">Перейти к серверам</ButtonLink>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

function StepIcon({ state }: { state: StepState }) {
  if (state === 'run')
    return (
      <LoaderCircle className="size-4 shrink-0 animate-spin text-accent" aria-label="загрузка" />
    );
  if (state === 'ok') return <Check className="size-4 shrink-0 text-ok" aria-label="готово" />;
  if (state === 'fail') return <X className="size-4 shrink-0 text-bad" aria-label="ошибка" />;
  return <Circle className="size-4 shrink-0 text-muted" aria-label="ожидает" />;
}
