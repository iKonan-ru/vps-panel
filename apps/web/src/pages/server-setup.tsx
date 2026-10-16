import { Breadcrumbs } from '@/components/breadcrumbs';
import { ParamField, ParamFields } from '@/components/command-run/param-field';
import { ProgressCard } from '@/components/server/setup/progress-card';
import { type SetupSearch, SourceCard, wipeOf } from '@/components/server/setup/source-card';
import { PortField } from '@/components/server/xui-inbound-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { api } from '@/lib/api';
import { isSecretParam, secretsMissing, useCommands, visibleParams } from '@/lib/commands';
import { dateTime } from '@/lib/format';
import { subscribe } from '@/lib/live';
import { serverLock, useServer } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams, useSearch } from '@tanstack/react-router';
import type {
  CommandInfo,
  SetupCheck,
  SetupMode,
  SetupPlan,
  SetupProgress,
  SetupStep,
} from '@vps/protocol';
import { ChevronDown, Play } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Поля команд, которые настройка задаёт сама: экземпляр AWG и поведение при уже стоящем. */
const HIDDEN = new Set(['AWG_INSTANCE', 'AWG_REPLACE']);

/** Поля шага: ответы команды каталога или свои (inbound-ы, адрес для клиентов). */
function StepFields({
  serverId,
  canPickPort,
  step,
  cmd,
  disabled,
  set,
  expanded,
  toggle,
}: {
  serverId: string;
  /** Свободный порт подбирает 3X-UI сервера: кнопка - только если она уже стоит. */
  canPickPort: boolean;
  step: SetupStep;
  cmd: CommandInfo | undefined;
  disabled: boolean;
  set: (name: string, value: string) => void;
  /** Все параметры команды; свёрнуто - только пароли (их нужно ввести). */
  expanded: boolean;
  toggle: () => void;
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
        ).map(([flag, port, label], i, all) => (
          <div key={flag} className="flex flex-col gap-1.5">
            <Checkbox
              label={label}
              checked={Boolean(a[flag])}
              disabled={disabled}
              onChange={(e) => set(flag, e.target.checked ? '1' : '')}
            />
            <PortField
              id={`setup-${port}`}
              serverId={serverId}
              value={a[port] ?? ''}
              onChange={(v) => set(port, v)}
              disabled={disabled || !a[flag]}
              pick={canPickPort}
              // соседний порт шага занят им самим
              avoid={all.filter((_, j) => j !== i).map(([, other]) => Number(a[other]) || 0)}
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
  const all = visibleParams(cmd.params, a).filter(
    (p) =>
      !HIDDEN.has(p.name) &&
      // данные из копии заменят пароли установщика
      !(step.fromBackup && (p.type === 'password' || p.secret)),
  );
  const params = expanded ? all : all.filter(isSecretParam);
  const more = all.length - all.filter(isSecretParam).length;
  return (
    <div className="flex flex-col gap-2">
      {params.length > 0 && (
        <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
          <ParamFields
            params={params}
            answers={a}
            onChange={set}
            awgContainers={[]}
            idPrefix={step.id}
            generate
          />
        </fieldset>
      )}
      {more > 0 && (
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1 text-xs text-accent"
          onClick={toggle}
        >
          <ChevronDown className={expanded ? 'size-3.5 rotate-180' : 'size-3.5'} />
          {expanded ? 'Свернуть параметры' : `Параметры: ${more}`}
        </button>
      )}
    </div>
  );
}

/** Что делать с уже стоящим сервисом. */
const MODE_LABEL: Record<SetupMode, string> = {
  keep: 'Оставить, данные заменит копия',
  reinstall: 'Переустановить',
  skip: 'Не трогать',
  remove: '',
  delete: '',
};

/** Что делать со старым сервером после переноса. */
const RETIRE_LABEL: Partial<Record<SetupMode, string>> = {
  remove: 'Снять с него сервисы и агента, удалить из панели',
  delete: 'Только удалить из панели (сервер не трогать)',
  keep: 'Оставить в панели, без клиентов',
};

/** Уже стоящий сервис (контейнер AWG): вместо галочки - выбор, что с ним делать. */
function ModeChoice({
  step,
  disabled,
  onChange,
}: {
  step: SetupStep;
  disabled: boolean;
  onChange: (mode: SetupMode) => void;
}) {
  const mode = (step.answers?.MODE ?? step.modes?.[0]) as SetupMode;
  return (
    <div className="flex flex-col gap-2">
      <div>
        <div className="text-sm font-medium">{step.title}</div>
        {step.note && <div className="text-xs text-muted">{step.note}</div>}
      </div>
      <div className="flex flex-col gap-1.5 pl-0.5">
        {(step.modes ?? []).map((m) => (
          <label key={m} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name={`mode-${step.id}`}
              checked={mode === m}
              disabled={disabled}
              onChange={() => onChange(m)}
            />
            {(step.kind === 'retire' ? RETIRE_LABEL[m] : undefined) ?? MODE_LABEL[m]}
          </label>
        ))}
      </div>
    </div>
  );
}

/**
 * Настройка сервера в один клик: шаги с ответами (по умолчанию отмечено всё, чего на сервере
 * нет), запуск одним действием, ход по шагам и продолжение с упавшего. С ?backup=<id> -
 * восстановление: сервисы как на старом сервере, затем данные копии.
 */
export function ServerSetupPage() {
  const { id } = useParams({ strict: false }) as { id: string };
  const q = useSearch({ strict: false }) as SetupSearch;
  const { backup, migrate } = q;
  const wipe = wipeOf(q);
  const source = `${backup ?? ''}|${migrate ?? ''}|${wipe ? 1 : 0}`;
  const qc = useQueryClient();
  const { data: s } = useServer(id);
  const cmds = useCommands();
  const plan = useQuery({
    queryKey: ['setup-plan', id, source],
    queryFn: () => {
      const p = new URLSearchParams();
      if (backup) p.set('backup', backup);
      if (migrate) p.set('migrate', migrate);
      if (wipe) p.set('wipe', '1');
      const qs = p.toString();
      return api<SetupPlan>(`/api/servers/${id}/setup${qs ? `?${qs}` : ''}`);
    },
    staleTime: Number.POSITIVE_INFINITY,
    refetchOnWindowFocus: false,
  });
  // ход - отдельно от плана (план считается дольше) и не под ключом карточки сервера: его
  // перечитывают только события настройки (эффект ниже), а не каждое событие сервера
  const prog = useQuery({
    queryKey: ['setup-progress', id],
    queryFn: () => api<{ progress: SetupProgress | null }>(`/api/servers/${id}/setup/progress`),
  });
  const [steps, setSteps] = useState<SetupStep[] | null>(null);
  const [planFor, setPlanFor] = useState<SetupPlan | null>(null);
  if (plan.data && plan.data !== planFor) {
    setPlanFor(plan.data);
    setSteps(plan.data.steps);
  }
  const [checks, setChecks] = useState<SetupCheck[] | null>(null);
  // другой источник (копия или пустой сервер) - шаги прежнего плана не показываем
  const [stepsKey, setStepsKey] = useState(source);
  if (source !== stepsKey) {
    setStepsKey(source);
    setSteps(null);
    setPlanFor(null);
    setChecks(null);
  }
  // шаги с развёрнутыми параметрами (по умолчанию видны только пароли)
  const [open, setOpen] = useState<Set<string>>(new Set());
  const act = useAction();
  const progress = prog.data?.progress ?? null;
  const running = Boolean(progress && !progress.finishedAt);
  // настройка закончилась - план заново: на сервере теперь другое, лишнее выключится
  const doneAt = progress?.finishedAt ?? null;
  const progLoaded = Boolean(prog.data);
  const seenDone = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!progLoaded) return;
    if (seenDone.current !== undefined && doneAt && doneAt !== seenDone.current)
      void qc.invalidateQueries({ queryKey: ['setup-plan', id] });
    seenDone.current = doneAt;
  }, [doneAt, progLoaded, qc, id]);
  const progressAction = progress?.actionId;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const reload = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      void qc.invalidateQueries({ queryKey: ['setup-progress', id] });
    };
    const un = subscribe((ev) => {
      if (ev.type === 'hello') return reload();
      if (ev.serverId !== id) return;
      // настройка началась, записала ход (server.changed) или закончилась - сразу
      if (ev.type === 'action.started' && ev.kind === 'server.setup') return reload();
      if (ev.type === 'server.changed' && running) return reload();
      if (!progressAction || ev.actionId !== progressAction) return;
      if (ev.type === 'action.finished') return reload();
      // вывод идёт: ход мог смениться, но не чаще раза в 2 с
      if (ev.type === 'action.stream') timer ??= setTimeout(reload, 2000);
    });
    return () => {
      un();
      if (timer) clearTimeout(timer);
    };
  }, [qc, id, progressAction, running]);
  const online = s?.status === 'online';
  const lock = s ? serverLock(s) : { busy: true, reason: undefined };
  const busy = !online || lock.busy || act.busy || running || !steps || prog.isFetching;

  const set = (stepId: string, patch: Partial<SetupStep> | ((st: SetupStep) => SetupStep)) =>
    setSteps((list) =>
      (list ?? []).map((st) =>
        st.id === stepId ? (typeof patch === 'function' ? patch(st) : { ...st, ...patch }) : st,
      ),
    );
  const body = (from?: string) => ({
    ...(backup ? { backupId: backup } : {}),
    ...(migrate ? { migrateFrom: migrate } : {}),
    ...(wipe ? { wipe: true } : {}),
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
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['servers', id], exact: true }),
        qc.invalidateQueries({ queryKey: ['setup-progress', id] }),
      ]);
    });
  }

  // шаги с непройденными проверками - по порядку на странице, ссылками к ним
  const failedSteps = (steps ?? []).filter((st) =>
    checks?.some((c) => c.step === st.id && c.level === 'fail'),
  );
  const missingPasswords = (steps ?? []).some((st) => {
    if (!st.enabled || st.kind !== 'service' || st.fromBackup || st.id.startsWith('awg-extra'))
      return false;
    if (st.modes && st.answers?.MODE !== 'reinstall') return false;
    const c = cmds.data?.find((x) => x.id === st.command);
    return secretsMissing(c?.params ?? [], st.answers ?? {});
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
      <SourceCard
        serverId={id}
        q={q}
        installed={plan.data?.installed}
        disabled={!online || lock.busy || running || act.busy}
      />
      {plan.data?.migrate ? (
        <Alert>
          Перенос с сервера <b>{plan.data.migrate.name}</b>
          {plan.data.backup?.id
            ? ` из копии от ${dateTime(plan.data.backup.createdAt)}`
            : ' со свежей копией'}
          : сервисы&nbsp;&mdash; как на нём, затем данные копии и его клиенты
        </Alert>
      ) : (
        plan.data?.backup && (
          <Alert>
            Восстановление копии от {dateTime(plan.data.backup.createdAt)}: сервисы&nbsp;&mdash; как
            были, затем данные из копии
          </Alert>
        )
      )}
      {!online && s && <Alert tone="bad">Сервер не в сети</Alert>}
      {plan.error && <Alert tone="bad">{plan.error.message}</Alert>}
      {act.error && <Alert tone="bad">{act.error}</Alert>}

      {progress && (
        <ProgressCard
          progress={progress}
          disabled={busy || missingPasswords}
          title={missingPasswords ? 'Не заполнены пароли' : lock.reason}
          onContinue={start}
        />
      )}

      {!steps ? (
        <Card className="p-8 text-[13px] text-muted">
          Опрос сервера: что уже сделано, а что нужно&hellip;
        </Card>
      ) : (
        <Card className="flex flex-col divide-y divide-border">
          {steps.map((st) => (
            <div
              key={st.id}
              id={`step-${st.id}`}
              className="flex scroll-mt-20 flex-col gap-3 px-4 py-3"
            >
              {st.modes ? (
                <ModeChoice
                  step={st}
                  disabled={busy}
                  onChange={(mode) =>
                    set(st.id, (x) => ({
                      ...x,
                      enabled: mode !== 'skip',
                      answers: { ...(x.answers ?? {}), MODE: mode },
                    }))
                  }
                />
              ) : (
                <Checkbox
                  label={<span className="font-medium">{st.title}</span>}
                  hint={st.note}
                  checked={st.enabled}
                  disabled={busy || st.locked}
                  onChange={(e) => set(st.id, { enabled: e.target.checked })}
                />
              )}
              {st.enabled &&
                ['service', 'inbounds', 'client-host'].includes(st.kind) &&
                !st.id.startsWith('awg-remove:') &&
                (!st.modes || st.answers?.MODE === 'reinstall') && (
                  <div className="pl-6.5">
                    <StepFields
                      serverId={id}
                      canPickPort={Boolean(s?.services.some((x) => x.kind === 'xui'))}
                      step={st}
                      cmd={cmds.data?.find((c) => c.id === st.command)}
                      disabled={busy}
                      expanded={open.has(st.id)}
                      toggle={() =>
                        setOpen((o) => {
                          const n = new Set(o);
                          if (n.has(st.id)) n.delete(st.id);
                          else n.add(st.id);
                          return n;
                        })
                      }
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

      {failedSteps.length > 0 && (
        <Alert tone="bad">
          <span>Не пройдены проверки: </span>
          {failedSteps.map((x, i) => (
            <span key={x.id}>
              {i > 0 && ', '}
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() =>
                  document
                    .getElementById(`step-${x.id}`)
                    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }
              >
                {x.title}
              </button>
            </span>
          ))}
        </Alert>
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
