import { ActionOutput } from '@/components/action-output';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ParamField } from '@/components/command-run/param-field';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { api } from '@/lib/api';
import { type CommandInfo, commandsApi, paramVisible } from '@/lib/commands';
import { dateTime } from '@/lib/format';
import { clampInt } from '@/lib/masks';
import { serverLock, useServer } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import type {
  SetupCheck,
  SetupPlan,
  SetupProgress,
  SetupStep,
  SetupStepState,
} from '@vps/protocol';
import { Play, RotateCcw } from 'lucide-react';
import { useState } from 'react';

/** Поля команд, которые настройка задаёт сама: экземпляр AWG и поведение при уже стоящем. */
const HIDDEN = new Set(['AWG_INSTANCE', 'AWG_REPLACE']);

const STATE: Record<
  SetupStepState,
  { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'accent' }
> = {
  pending: { text: 'ждёт', tone: 'muted' },
  running: { text: 'идёт', tone: 'accent' },
  done: { text: 'готово', tone: 'ok' },
  skipped: { text: 'пропущен', tone: 'muted' },
  failed: { text: 'ошибка', tone: 'bad' },
};

/** Поля шага: ответы команды каталога или свои (inbound-ы, адрес для клиентов). */
function StepFields({
  step,
  cmd,
  disabled,
  set,
}: {
  step: SetupStep;
  cmd: CommandInfo | undefined;
  disabled: boolean;
  set: (name: string, value: string) => void;
}) {
  const a = step.answers ?? {};
  if (step.kind === 'client-host')
    return (
      <Field
        label="Имя"
        htmlFor="setup-client-host"
        hint={<>A-запись на IP сервера; пусто&nbsp;&mdash; клиенты получат IP</>}
      >
        <Input
          id="setup-client-host"
          value={a.NAME ?? ''}
          placeholder="srv.example.com"
          disabled={disabled}
          onChange={(e) => set('NAME', e.target.value.trim().toLowerCase())}
        />
      </Field>
    );
  if (step.kind === 'inbounds')
    return (
      <div className="grid gap-3 sm:grid-cols-2">
        {(
          [
            ['RAW', 'RAW_PORT', 'VLESS RAW'],
            ['XHTTP', 'XHTTP_PORT', 'XHTTP'],
          ] as const
        ).map(([flag, port, label]) => (
          <div key={flag} className="flex flex-col gap-1.5">
            <Checkbox
              label={label}
              checked={Boolean(a[flag])}
              disabled={disabled}
              onChange={(e) => set(flag, e.target.checked ? '1' : '')}
            />
            <Input
              aria-label={`Порт ${label}`}
              value={a[port] ?? ''}
              inputMode="numeric"
              className="font-mono"
              disabled={disabled || !a[flag]}
              onChange={(e) => set(port, clampInt(e.target.value, 1, 65535))}
            />
          </div>
        ))}
      </div>
    );
  if (step.kind !== 'service' || !cmd) return null;
  // дополнительный AWG: версия; порт и подсеть - из копии или подберутся при запуске
  if (step.id.startsWith('awg-extra')) {
    if (step.locked)
      return (
        <div className="text-xs text-muted">
          версия {a.AWG_VERSION}, порт UDP {a.AWG_SERVER_PORT}
        </div>
      );
    const p = cmd.params.find((x) => x.name === 'AWG_VERSION');
    return p ? (
      <div className="grid gap-3 sm:grid-cols-2">
        <ParamField
          p={p}
          idPrefix={step.id}
          value={a.AWG_VERSION ?? ''}
          onChange={(v) => set('AWG_VERSION', v)}
          awgContainers={[]}
        />
        <div className="self-end pb-2 text-xs text-muted">порт и подсеть подберутся сами</div>
      </div>
    ) : null;
  }
  const params = cmd.params.filter(
    (p) =>
      !HIDDEN.has(p.name) &&
      paramVisible(p, a) &&
      // данные из копии заменят пароли установщика
      !(step.fromBackup && (p.type === 'password' || p.secret)),
  );
  return (
    <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
      {params.map((p) => (
        <ParamField
          key={p.name}
          p={p}
          idPrefix={step.id}
          value={a[p.name] ?? ''}
          onChange={(v) => set(p.name, v)}
          awgContainers={[]}
        />
      ))}
    </fieldset>
  );
}

/**
 * Настройка сервера в один клик: шаги с ответами (по умолчанию отмечено всё, чего на сервере
 * нет), запуск одним действием, ход по шагам и продолжение с упавшего. С ?backup=<id> -
 * восстановление: сервисы как на старом сервере, затем данные копии.
 */
export function ServerSetupPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const { backup } = useSearch({ strict: false }) as { backup?: string };
  const qc = useQueryClient();
  const { data: s } = useServer(id);
  const cmds = useQuery({ queryKey: ['commands'], queryFn: commandsApi.list });
  const plan = useQuery({
    queryKey: ['setup-plan', id, backup ?? ''],
    queryFn: () =>
      api<SetupPlan>(
        `/api/servers/${id}/setup${backup ? `?backup=${encodeURIComponent(backup)}` : ''}`,
      ),
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  // ход - отдельно: его обновляет каждое событие сервера, а план считается дольше
  const prog = useQuery({
    queryKey: ['servers', id, 'setup-progress'],
    queryFn: () => api<{ progress: SetupProgress | null }>(`/api/servers/${id}/setup/progress`),
  });
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [planFor, setPlanFor] = useState<SetupPlan | null>(null);
  if (plan.data && plan.data !== planFor) {
    setPlanFor(plan.data);
    setSteps(plan.data.steps);
  }
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  const act = useAction();
  const progress = prog.data?.progress ?? null;
  const running = Boolean(progress && !progress.finishedAt);
  const online = s?.status === 'online';
  const lock = s ? serverLock(s) : { busy: true, reason: undefined };
  const busy = !online || lock.busy || act.busy || running || !steps || prog.isFetching;
  const failed = progress?.finishedAt
    ? progress.steps.find((x) => x.state === 'failed')
    : undefined;

  const set = (stepId: string, patch: Partial<SetupStep> | ((st: SetupStep) => SetupStep)) =>
    setSteps((list) =>
      (list ?? []).map((st) =>
        st.id === stepId ? (typeof patch === 'function' ? patch(st) : { ...st, ...patch }) : st,
      ),
    );
  const body = (from?: string) => ({
    ...(backup ? { backupId: backup } : {}),
    ...(from ? { from } : {}),
    steps: (steps ?? []).map((st) => ({
      id: st.id,
      enabled: st.enabled,
      answers: st.answers ?? {},
    })),
  });

  function start(from?: string) {
    void act.run(async () => {
      setChecks(null);
      if (!from) {
        const r = await api<{ checks: SetupCheck[]; canRun: boolean }>(
          `/api/servers/${id}/setup/preflight`,
          { method: 'POST', json: body() },
        );
        setChecks(r.checks);
        if (!r.canRun) return;
      }
      await api(`/api/servers/${id}/setup/run`, { method: 'POST', json: body(from) });
      await qc.invalidateQueries({ queryKey: ['servers', id] });
    });
  }

  const missingPasswords = (steps ?? []).some((st) => {
    if (!st.enabled || st.kind !== 'service' || st.fromBackup || st.id.startsWith('awg-extra'))
      return false;
    const c = cmds.data?.find((x) => x.id === st.command);
    return (c?.params ?? []).some(
      (p) =>
        p.required &&
        (p.type === 'password' || p.secret) &&
        paramVisible(p, st.answers ?? {}) &&
        !st.answers?.[p.name],
    );
  });

  return (
    <>
      <Breadcrumbs
        items={[
          { label: 'Серверы', to: '/' },
          { label: s?.name ?? '', to: `/servers/${id}` },
          { label: 'Настройка сервера' },
        ]}
      />
      <PageTitle hero>Настройка сервера</PageTitle>
      {plan.data?.backup && (
        <Alert>
          Восстановление копии <b>{plan.data.backup.serverName}</b> от{' '}
          {dateTime(plan.data.backup.createdAt)}: сервисы&nbsp;&mdash; как на старом сервере, затем
          данные из копии
        </Alert>
      )}
      {!online && s && <Alert tone="bad">Сервер не в сети</Alert>}
      {plan.error && <Alert tone="bad">{plan.error.message}</Alert>}
      {act.error && <Alert tone="bad">{act.error}</Alert>}

      {progress && (
        <Card className="flex flex-col gap-3 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="font-semibold">
              {running ? 'Идёт настройка' : `Настройка от ${dateTime(progress.startedAt)}`}
            </div>
            <div className="grow" />
            {failed && (
              <Button
                size="sm"
                variant="primary"
                disabled={busy}
                title={lock.reason}
                onClick={() => start(failed.id)}
              >
                <RotateCcw className="size-3.5" />
                Продолжить с шага &laquo;{failed.title}&raquo;
              </Button>
            )}
          </div>
          <div className="flex flex-col gap-1.5 text-[13px]">
            {progress.steps.map((x) => (
              <div key={x.id} className="flex items-start gap-2">
                <Chip
                  tone={STATE[x.state].tone}
                  dot={x.state === 'running'}
                  pulse={x.state === 'running'}
                >
                  {STATE[x.state].text}
                </Chip>
                <div className="min-w-0">
                  <div>{x.title}</div>
                  {x.note && (
                    <div
                      className={x.state === 'failed' ? 'text-xs text-bad' : 'text-xs text-muted'}
                    >
                      {x.note}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <ActionOutput
            actionId={progress.actionId}
            onFinished={() => void qc.invalidateQueries({ queryKey: ['servers', id] })}
          />
        </Card>
      )}

      {!steps ? (
        <Card className="p-8 text-[13px] text-muted">Загрузка&hellip;</Card>
      ) : (
        <Card className="flex flex-col divide-y divide-border">
          {steps.map((st) => (
            <div key={st.id} className="flex flex-col gap-3 px-4 py-3">
              <Checkbox
                label={<span className="font-medium">{st.title}</span>}
                hint={st.note}
                checked={st.enabled}
                disabled={busy || st.locked}
                onChange={(e) => set(st.id, { enabled: e.target.checked })}
              />
              {st.enabled && (
                <div className="pl-6.5">
                  <StepFields
                    step={st}
                    cmd={cmds.data?.find((c) => c.id === st.command)}
                    disabled={busy}
                    set={(name, value) =>
                      set(st.id, (x) => ({
                        ...x,
                        answers: { ...(x.answers ?? {}), [name]: value },
                      }))
                    }
                  />
                </div>
              )}
              {checks
                ?.filter((c) => c.step === st.id)
                .map((c, i) => (
                  <div
                    key={`${c.text}-${i}`}
                    className={
                      c.level === 'fail' ? 'pl-6.5 text-xs text-bad' : 'pl-6.5 text-xs text-warn'
                    }
                  >
                    {c.text}
                  </div>
                ))}
            </div>
          ))}
        </Card>
      )}

      {checks?.some((c) => c.level === 'fail') && (
        <Alert tone="bad">Проверки не пройдены: причины&nbsp;&mdash; у шагов</Alert>
      )}
      <div className="flex flex-wrap items-center justify-end gap-3">
        {missingPasswords && <span className="text-xs text-muted">Не заполнены пароли</span>}
        <Button
          variant="primary"
          disabled={busy || missingPasswords || !(steps ?? []).some((x) => x.enabled)}
          title={lock.reason}
          onClick={() => start()}
        >
          <Play className="size-4" />
          Настроить
        </Button>
      </div>
    </>
  );
}
