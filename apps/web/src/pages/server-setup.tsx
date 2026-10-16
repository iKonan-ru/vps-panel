import { ActionOutput } from '@/components/action-output';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ParamField } from '@/components/command-run/param-field';
import { ServerOptions } from '@/components/server-options';
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
import { type CommandInfo, paramVisible, useCommands } from '@/lib/commands';
import { dateTime } from '@/lib/format';
import { subscribe } from '@/lib/live';
import { clampInt } from '@/lib/masks';
import { serverLock, useServer, useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import type {
  SetupCheck,
  SetupMode,
  SetupPlan,
  SetupProgress,
  SetupStep,
  SetupStepState,
} from '@vps/protocol';
import { ChevronDown, Play, RotateCcw, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

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

/** Копия в списке панели: с составом сервисов (с версии 1.6) её можно развернуть. */
interface BackupRow {
  id: string;
  serverId: string | null;
  serverName: string;
  createdAt: string;
  manifest: { setup?: unknown };
}

/** Источник настройки в адресе: копия, старый сервер при переносе, очистка ("1"/"0"). */
export interface SetupSearch {
  backup?: string | undefined;
  migrate?: string | undefined;
  wipe?: string | undefined;
}

/** Очистка по умолчанию: при переносе - да (сервер под старый), при восстановлении - нет. */
export const wipeOf = (q: SetupSearch) =>
  q.wipe === undefined ? Boolean(q.migrate) : q.wipe === '1';

type SourceMode = 'empty' | 'copy' | 'migrate';

/**
 * Откуда настройка: пустой сервер, резервная копия этого же сервера (из панели или скачанный
 * раньше файл - например, после переустановки) или перенос с другого сервера панели: его
 * копия (свежая, если он в сети) и его клиенты переходят сюда.
 */
function SourceCard({
  serverId,
  q,
  installed,
  disabled,
}: {
  serverId: string;
  q: SetupSearch;
  installed: string[] | undefined;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<SourceMode>(q.migrate ? 'migrate' : q.backup ? 'copy' : 'empty');
  const upload = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const list = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<BackupRow[]>('/api/backups'),
    enabled: mode !== 'empty',
  });
  const servers = useServers();
  const others = (servers.data ?? []).filter((x) => x.id !== serverId);
  const old = others.find((x) => x.id === q.migrate);
  // копии с составом сервисов: свои - для восстановления, старого сервера - для переноса
  const owner = mode === 'migrate' ? q.migrate : serverId;
  const copies = (list.data ?? []).filter((b) => b.serverId === owner && b.manifest.setup);
  const go = (next: SetupSearch) =>
    void navigate({
      to: '/servers/$id/setup',
      params: { id: serverId },
      search: { backup: next.backup, migrate: next.migrate, wipe: next.wipe },
    });
  const off = disabled || upload.busy;
  const wipe = wipeOf(q);
  // старый сервер не в сети: свежую копию не снять - берётся последняя его копия в панели
  const latest = copies[0]?.id;
  const needCopy = mode === 'migrate' && Boolean(old) && old?.status !== 'online' && !q.backup;
  useEffect(() => {
    if (needCopy && latest)
      void navigate({
        to: '/servers/$id/setup',
        params: { id: serverId },
        search: { backup: latest, migrate: q.migrate, wipe: q.wipe },
        replace: true,
      });
  }, [needCopy, latest, navigate, serverId, q.migrate, q.wipe]);

  function send(file: File) {
    if (!owner) return;
    void upload.run(async () => {
      // файл становится копией того сервера, чья она: этого или старого при переносе
      const r = await api<{ id: string }>(`/api/servers/${owner}/backups/upload`, {
        method: 'POST',
        body: file,
        // скачанная копия зашифрована (.tar.gz.enc), старая - просто .tar.gz
        headers: { 'content-type': 'application/octet-stream' },
      });
      await qc.invalidateQueries({ queryKey: ['backups'] });
      go({ ...q, backup: r.id });
    });
  }

  const radio = (m: SourceMode, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name="setup-source"
        checked={mode === m}
        disabled={off}
        onChange={() => {
          setMode(m);
          go({});
        }}
      />
      {label}
    </label>
  );

  const fileButton = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".enc,.gz,.tgz,application/gzip,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) send(f);
        }}
      />
      <Button disabled={off || !owner} onClick={() => fileRef.current?.click()}>
        <Upload className={upload.busy ? 'size-4 animate-pulse' : 'size-4'} />
        {upload.busy ? 'Загрузка\u2026' : 'Загрузить файл'}
      </Button>
    </>
  );

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {radio('empty', 'Пустой сервер')}
        {radio('copy', 'Резервная копия этого сервера')}
        {radio('migrate', 'Перенос с другого сервера')}
      </div>
      {mode === 'copy' && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Копия" htmlFor="setup-backup" className="grow">
            <Select
              id="setup-backup"
              value={q.backup ?? ''}
              disabled={off || list.isFetching}
              onChange={(e) => go({ ...q, backup: e.target.value || undefined })}
            >
              <option value="">{copies.length ? 'не выбрана' : 'копий этого сервера нет'}</option>
              {copies.map((b) => (
                <option key={b.id} value={b.id}>
                  {dateTime(b.createdAt)}
                </option>
              ))}
            </Select>
          </Field>
          {fileButton}
        </div>
      )}
      {mode === 'migrate' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Старый сервер" htmlFor="setup-migrate" className="grow">
              <Select
                id="setup-migrate"
                value={q.migrate ?? ''}
                disabled={off}
                onChange={(e) => go({ migrate: e.target.value || undefined, wipe: q.wipe })}
              >
                <option value="">не выбран</option>
                <ServerOptions servers={others} />
              </Select>
            </Field>
            {q.migrate && (
              <Field label="Данные" htmlFor="setup-migrate-copy" className="grow">
                <Select
                  id="setup-migrate-copy"
                  value={q.backup ?? ''}
                  disabled={off || list.isFetching}
                  onChange={(e) => go({ ...q, backup: e.target.value || undefined })}
                >
                  <option value="">
                    {old?.status === 'online'
                      ? 'свежая копия при переносе'
                      : 'не в сети: выберите его копию'}
                  </option>
                  {copies.map((b) => (
                    <option key={b.id} value={b.id}>
                      копия от {dateTime(b.createdAt)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {q.migrate && fileButton}
          </div>
          <div className="text-xs text-muted">
            Сервисы ставятся как на старом сервере, данные&nbsp;&mdash; из копии, клиенты панели
            переходят сюда с теми же ключами. Если клиенты подключаются по имени (адрес для
            клиентов), его A-запись нужно перевести на IP этого сервера до запуска.
          </div>
        </div>
      )}
      {mode !== 'empty' && Boolean(installed?.length) && (
        <Checkbox
          label="Удалить то, что уже стоит на сервере"
          hint={`${installed?.join(', ')}: удаляются перед установкой, всё ставится заново`}
          checked={wipe}
          disabled={off}
          onChange={(e) => go({ ...q, wipe: e.target.checked ? '1' : '0' })}
        />
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
  const [showOutput, setShowOutput] = useState(false);
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
                title={
                  missingPasswords
                    ? 'Не заполнены пароли'
                    : (lock.reason ?? `Продолжить с шага \u00ab${failed.title}\u00bb`)
                }
                onClick={() => start(failed.id)}
              >
                <RotateCcw className="size-3.5" />
                {/* на узком экране название шага не помещается: упавший шаг виден в списке */}
                Продолжить
                <span className="max-sm:hidden">с шага &laquo;{failed.title}&raquo;</span>
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
            <ActionOutput actionId={progress.actionId} />
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
