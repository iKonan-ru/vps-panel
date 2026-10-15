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
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { type CommandInfo, commandsApi, paramVisible } from '@/lib/commands';
import { dateTime } from '@/lib/format';
import { clampInt } from '@/lib/masks';
import { serverLock, useServer } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type {
  SetupCheck,
  SetupPlan,
  SetupProgress,
  SetupStep,
  SetupStepState,
} from '@vps/protocol';
import { ChevronDown, Play, RotateCcw, Upload } from 'lucide-react';
import { useRef, useState } from 'react';

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
  expanded,
  toggle,
}: {
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
  const all = cmd.params.filter(
    (p) =>
      !HIDDEN.has(p.name) &&
      paramVisible(p, a) &&
      // данные из копии заменят пароли установщика
      !(step.fromBackup && (p.type === 'password' || p.secret)),
  );
  const isPassword = (p: (typeof all)[number]) => p.required && (p.type === 'password' || p.secret);
  const params = expanded ? all : all.filter(isPassword);
  const more = all.length - all.filter(isPassword).length;
  return (
    <div className="flex flex-col gap-2">
      {params.length > 0 && (
        <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2">
          {params.map((p) => (
            <ParamField
              key={p.name}
              p={p}
              idPrefix={step.id}
              value={a[p.name] ?? ''}
              onChange={(v) => set(p.name, v)}
              awgContainers={[]}
              generate
            />
          ))}
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

/** Копия в списке панели: с составом сервисов (с версии 1.6) её можно развернуть. */
interface BackupRow {
  id: string;
  serverId: string | null;
  serverName: string;
  createdAt: string;
  manifest: { setup?: unknown };
}

/**
 * Откуда настройка: пустой сервер или резервная копия - любого сервера панели или файл,
 * скачанный раньше (загружается и становится копией этого сервера).
 */
function SourceCard({
  serverId,
  backup,
  disabled,
}: {
  serverId: string;
  backup: string | undefined;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [fromCopy, setFromCopy] = useState(Boolean(backup));
  const upload = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const list = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<BackupRow[]>('/api/backups'),
    enabled: fromCopy,
  });
  const copies = (list.data ?? []).filter((b) => b.serverId && b.manifest.setup);
  const go = (b: string | undefined) =>
    void navigate({ to: '/servers/$id/setup', params: { id: serverId }, search: { backup: b } });
  const off = disabled || upload.busy;

  function send(file: File) {
    void upload.run(async () => {
      const r = await api<{ id: string }>(`/api/servers/${serverId}/backups/upload`, {
        method: 'POST',
        body: file,
        headers: { 'content-type': 'application/gzip' },
      });
      await qc.invalidateQueries({ queryKey: ['backups'] });
      go(r.id);
    });
  }

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="setup-source"
            checked={!fromCopy}
            disabled={off}
            onChange={() => {
              setFromCopy(false);
              go(undefined);
            }}
          />
          Пустой сервер
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="radio"
            name="setup-source"
            checked={fromCopy}
            disabled={off}
            onChange={() => setFromCopy(true)}
          />
          Из резервной копии
        </label>
      </div>
      {fromCopy && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Копия" htmlFor="setup-backup" className="grow">
            <Select
              id="setup-backup"
              value={backup ?? ''}
              disabled={off || list.isFetching}
              onChange={(e) => go(e.target.value || undefined)}
            >
              <option value="">
                {copies.length ? 'не выбрана' : 'копий с составом сервисов нет'}
              </option>
              {copies.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.serverName}, {dateTime(b.createdAt)}
                </option>
              ))}
            </Select>
          </Field>
          <input
            ref={fileRef}
            type="file"
            accept=".gz,.tgz,application/gzip"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) send(f);
            }}
          />
          <Button disabled={off} onClick={() => fileRef.current?.click()}>
            <Upload className={upload.busy ? 'size-4 animate-pulse' : 'size-4'} />
            {upload.busy ? 'Загрузка\u2026' : 'Загрузить файл'}
          </Button>
        </div>
      )}
      {upload.error && <Alert tone="bad">{upload.error}</Alert>}
    </Card>
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
  // другой источник (копия или пустой сервер) - шаги прежнего плана не показываем
  const [stepsKey, setStepsKey] = useState(backup ?? '');
  if ((backup ?? '') !== stepsKey) {
    setStepsKey(backup ?? '');
    setSteps(null);
    setPlanFor(null);
    setChecks(null);
  }
  // шаги с развёрнутыми параметрами (по умолчанию видны только пароли)
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [showOutput, setShowOutput] = useState(false);
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
      <SourceCard
        serverId={id}
        backup={backup}
        disabled={!online || lock.busy || running || act.busy}
      />
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
                disabled={busy || missingPasswords}
                title={missingPasswords ? 'Не заполнены пароли' : lock.reason}
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
          {running || showOutput ? (
            <ActionOutput
              actionId={progress.actionId}
              onFinished={() => void qc.invalidateQueries({ queryKey: ['servers', id] })}
            />
          ) : (
            <button
              type="button"
              className="inline-flex w-fit items-center gap-1 text-xs text-accent"
              onClick={() => setShowOutput(true)}
            >
              <ChevronDown className="size-3.5" />
              Показать вывод
            </button>
          )}
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
              {st.enabled && ['service', 'inbounds', 'client-host'].includes(st.kind) && (
                <div className="pl-6.5">
                  <StepFields
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
