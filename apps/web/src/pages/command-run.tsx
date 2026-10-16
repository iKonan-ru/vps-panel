import { ActionOutput } from '@/components/action-output';
import { ActionStatusChip } from '@/components/actions-table';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { History } from '@/components/command-run/history';
import { ParamFields } from '@/components/command-run/param-field';
import { ServerOptions } from '@/components/server-options';
import { Alert } from '@/components/ui/alert';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { PageTitle } from '@/components/ui/page-title';
import { Select } from '@/components/ui/select';
import { Tabs } from '@/components/ui/tabs';
import {
  type Check,
  commandsApi,
  secretsMissing,
  useCommands,
  visibleParams,
} from '@/lib/commands';
import { cap } from '@/lib/format';
import { serverLock, useServer, useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  Check as CheckIcon,
  ClipboardCheck,
  Play,
  Server,
  Square,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

type Tab = 'form' | 'output' | 'history';

/** Запуск команды: сервер и вопросы, план, проверки, живой вывод, история на сервере. */
export function CommandRunPage() {
  const { id } = useParams({ from: '/app/commands/$id' });
  const search = useSearch({ from: '/app/commands/$id' });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: cmds, isFetching: cmdsFetching } = useCommands();
  const { data: servers } = useServers();
  const cmd = cmds?.find((c) => c.id === id);
  // каталог мог обновиться после выкладки панели: перед "не найдена" перечитываем
  const [retried, setRetried] = useState(false);
  useEffect(() => {
    if (cmds && !cmd && !retried) {
      setRetried(true);
      void qc.invalidateQueries({ queryKey: ['commands'] });
    }
  }, [cmds, cmd, retried, qc]);

  const [serverId, setServerId] = useState<string>(search.server ?? '');
  // по умолчанию - вывод, если открыт запуск, иначе форма
  const tab: Tab = search.tab ?? (search.run ? 'output' : 'form');
  const setTab = (t: Tab) =>
    void navigate({
      to: '/commands/$id',
      params: { id },
      search: (prev) => ({ server: prev.server, run: prev.run, tab: t }),
      replace: true,
    });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [loadedFor, setLoadedFor] = useState<string>('');
  const [plan, setPlan] = useState<string[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [checks, setChecks] = useState<Check[] | null>(null);
  // запуск, проверки и остановка - одно действие страницы: ошибка - в op.error
  const op = useAction();
  // идёт именно проверка (значок кнопки "Проверить")
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionId, setActionId] = useState<string | null>(search.run ?? null);
  // сервер открытого запуска: в форме тем временем могут выбрать другой
  const [runServerId, setRunServerId] = useState<string>(search.server ?? '');
  const [finished, setFinished] = useState<number | null>(null);
  const [showAll, setShowAll] = useState(false);

  const detail = useServer(serverId);
  const lock = detail.data ? serverLock(detail.data) : { busy: false, reason: undefined };
  // для параметров awg-container
  const awgContainers = useMemo(
    () =>
      (detail.data?.inventory?.services ?? [])
        .filter((sv) => sv.kind === 'amnezia' && typeof sv.details?.container === 'string')
        .map((sv) => {
          const name = String(sv.details?.container);
          const state =
            sv.details?.state === 'running' ? '' : `, ${String(sv.details?.state ?? '')}`;
          // "0.0.0.0:45987->45987/udp" -> "45987/udp"
          const ports = sv.ports.map((p) => p.replace(/^.*:(\d+)->\d+/, '$1'));
          return { name, label: `${name} (${ports.join(', ') || 'порт не определён'}${state})` };
        }),
    [detail.data],
  );
  const online = useMemo(() => (servers ?? []).filter((s) => s.status === 'online'), [servers]);
  useEffect(() => {
    if (!serverId && online.length === 1 && online[0]) setServerId(online[0].id);
  }, [online, serverId]);

  useEffect(() => {
    if (!cmd || !serverId || loadedFor === `${cmd.id}:${serverId}`) return;
    commandsApi
      .defaults(serverId, cmd.id)
      .then((d) => {
        // ответы из ссылки (preset): только для сервера из ссылки и только обычные поля команды -
        // пароли и подтверждение удаления ссылкой не задаются
        const preset =
          search.preset && serverId === search.server
            ? Object.fromEntries(
                Object.entries(search.preset).filter(([k]) =>
                  cmd.params.some(
                    (p) =>
                      p.name === k && p.name !== 'CONFIRM' && p.type !== 'password' && !p.secret,
                  ),
                ),
              )
            : {};
        setAnswers({ ...d, ...preset });
        setLoadedFor(`${cmd.id}:${serverId}`);
        setChecks(null);
      })
      .catch((e: Error) => setError(e.message));
  }, [cmd, serverId, loadedFor, search.preset, search.server]);

  const planTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // план пересчитывается: до ответа ошибки в форме - от прошлых ответов, запуск недоступен
  const [planPending, setPlanPending] = useState(false);
  useEffect(() => {
    if (!cmd || !serverId || loadedFor !== `${cmd.id}:${serverId}`) return;
    if (planTimer.current) clearTimeout(planTimer.current);
    setPlanPending(true);
    planTimer.current = setTimeout(() => {
      commandsApi
        .plan(serverId, cmd.id, answers)
        .then((p) => {
          setPlan(p.steps);
          setErrors(p.errors);
        })
        // план не рассчитан: ошибка в форме и запуск недоступен, а не план от прошлых ответов
        .catch((e: Error) => setErrors([cap(e.message)]))
        .finally(() => setPlanPending(false));
    }, 300);
  }, [cmd, serverId, answers, loadedFor]);

  const set = useCallback((name: string, value: string) => {
    setAnswers((a) => ({ ...a, [name]: value }));
    setChecks(null);
  }, []);

  async function runPreflight() {
    if (!cmd) return;
    setChecking(true);
    await op.run(async () => {
      setChecks((await commandsApi.preflight(serverId, cmd.id, answers)).checks);
    });
    setChecking(false);
  }

  async function run() {
    if (!cmd) return;
    await op.run(async () => {
      const r = await commandsApi.run(serverId, cmd.id, answers);
      setActionId(r.actionId);
      setRunServerId(serverId);
      setFinished(null);
      void navigate({
        to: '/commands/$id',
        params: { id: cmd.id },
        search: { server: serverId, run: r.actionId, tab: 'output' },
        replace: true,
      });
      void qc.invalidateQueries({ queryKey: ['actions'] });
    });
  }

  async function cancel() {
    if (!actionId) return;
    await op.run(() => commandsApi.cancel(actionId));
  }

  if (!cmds || (!cmd && (!retried || cmdsFetching)))
    return <Card className="p-8 text-muted">Загрузка&hellip;</Card>;
  if (!cmd) return <Card className="p-8 text-bad">Команда не найдена</Card>;
  const server = servers?.find((s) => s.id === serverId);
  const runServer = servers?.find((s) => s.id === runServerId);
  // ответы этого сервера загружены, план и проверки свежие, карточка сервера есть; занятость
  // сервера - отдельно, lock.busy
  const canRun =
    Boolean(serverId) &&
    errors.length === 0 &&
    !op.busy &&
    !planPending &&
    Boolean(detail.data) &&
    loadedFor === `${cmd.id}:${serverId}` &&
    (!checks || !checks.some((c) => c.level === 'fail'));
  const missingSecrets = secretsMissing(cmd.params, answers);

  return (
    <>
      <Breadcrumbs items={[{ label: 'Команды', to: '/commands' }, { label: cmd.title }]} />
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle hero>{cmd.title}</PageTitle>
      </div>
      <Tabs<Tab>
        items={[
          { id: 'form', title: 'Форма' },
          { id: 'output', title: 'Вывод' },
          { id: 'history', title: server ? `История на ${server.name}` : 'История' },
        ]}
        value={tab}
        onChange={setTab}
      />

      {(error ?? op.error) && <Alert tone="bad">{error ?? op.error}</Alert>}

      {tab === 'form' && (
        <>
          <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
            <Card className="flex flex-col gap-4 p-5">
              <div className="text-[13px] leading-relaxed text-muted">{cmd.description}</div>
              <Field label="Сервер" htmlFor="cmd-server">
                <Select
                  id="cmd-server"
                  value={serverId}
                  onChange={(e) => setServerId(e.target.value)}
                >
                  <option value="">не выбран</option>
                  <ServerOptions servers={servers} withHost onlineOnly />
                </Select>
              </Field>
              {serverId && loadedFor !== `${cmd.id}:${serverId}` && (
                <div className="text-sm text-muted">Загрузка&hellip;</div>
              )}
              {serverId && loadedFor === `${cmd.id}:${serverId}` && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <ParamFields
                    params={visibleParams(cmd.params, answers)}
                    answers={answers}
                    onChange={set}
                    awgContainers={awgContainers}
                  />
                  {cmd.params.length === 0 && (
                    <div className="text-sm text-muted sm:col-span-2">Параметров нет</div>
                  )}
                </div>
              )}
              {errors.length > 0 && (
                <Alert tone="bad">
                  {errors.map((e) => (
                    <div key={e}>{e}</div>
                  ))}
                </Alert>
              )}
            </Card>

            <div className="flex flex-col gap-4">
              <Card className="flex flex-col gap-2.5 p-4">
                <div className="font-semibold">Что будет сделано</div>
                {plan.length === 0 ? (
                  <div className="text-[13px] text-muted">Сервер не выбран</div>
                ) : (
                  <div className="flex flex-col gap-1.5 text-[13px]">
                    {plan.map((s) => (
                      <div key={s} className="flex items-start gap-2">
                        <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
                        <span>{s}</span>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
              <Card className="flex flex-col gap-2.5 p-4">
                <div className="flex items-center gap-2.5">
                  <div className="font-semibold">Проверки перед запуском</div>
                  {checks &&
                    (checks.some((c) => c.level === 'fail') ? (
                      <Chip tone="bad">есть проблемы</Chip>
                    ) : checks.some((c) => c.level === 'warn') ? (
                      <Chip tone="warn">есть предупреждения</Chip>
                    ) : (
                      <Chip tone="ok">всё в порядке</Chip>
                    ))}
                  <div className="grow" />
                  <Button
                    size="sm"
                    disabled={!serverId || op.busy || errors.length > 0}
                    onClick={runPreflight}
                    label="Проверить"
                  >
                    <ClipboardCheck className={checking ? 'size-3.5 animate-pulse' : 'size-3.5'} />
                  </Button>
                </div>
                {checks ? (
                  <div className="flex flex-col gap-1.5 text-[13px]">
                    {checks.map((c, i) => (
                      <div key={`${c.text}-${i}`} className="flex items-start gap-2">
                        {c.level === 'ok' ? (
                          <CheckIcon className="mt-0.5 size-4 shrink-0 text-ok" />
                        ) : c.level === 'warn' ? (
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
                        ) : (
                          <X className="mt-0.5 size-4 shrink-0 text-bad" />
                        )}
                        <span>{c.text}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
              </Card>
              {cmd.after && (
                <Card className="p-4 text-[13px] text-muted">
                  <span className="font-medium text-text">После установки: </span>
                  {cmd.after}
                </Card>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <InfoTip>Ответы запоминаются для следующего запуска, кроме паролей</InfoTip>
            <div className="grow" />
            <ButtonLink to="/commands" search={{ server: undefined }}>
              Отмена
            </ButtonLink>
            <Button
              variant="primary"
              disabled={!canRun || missingSecrets || lock.busy}
              onClick={run}
              title={lock.reason ?? (missingSecrets ? 'Не заполнены пароли' : '')}
              label={server ? `Запустить на ${server.name}` : 'Запустить'}
            >
              <Play className="size-4" />
            </Button>
          </div>
        </>
      )}

      {tab === 'output' && (
        <Card className="flex flex-col gap-3 p-4">
          {!actionId ? (
            <div className="text-[13px] text-muted">Запусков пока нет</div>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="font-semibold">
                  {cmd.title}
                  {runServer ? `: ${runServer.name}` : ''}
                </div>
                <ActionStatusChip
                  finishedAt={finished === null ? null : 'done'}
                  exitCode={finished}
                  withCode
                />
                <div className="grow" />
                {finished === null && (
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={op.busy}
                    onClick={cancel}
                    label="Остановить"
                  >
                    <Square className="size-3.5" />
                  </Button>
                )}
                {finished !== null && (
                  <Button size="sm" onClick={() => setTab('form')} label="Запустить ещё раз">
                    <Play className="size-3.5" />
                  </Button>
                )}
              </div>
              <ActionOutput actionId={actionId} onFinished={setFinished} tall />
              {finished === 0 && cmd.after && <Alert tone="ok">{cmd.after}</Alert>}
              {finished === 0 && runServer && (
                <div>
                  <ButtonLink
                    to="/servers/$id"
                    params={{ id: runServer.id }}
                    size="sm"
                    label="Открыть сервер"
                  >
                    <Server className="size-3.5" />
                  </ButtonLink>
                </div>
              )}
            </>
          )}
        </Card>
      )}

      {tab === 'history' && (
        <History
          serverId={serverId}
          commandId={cmd.id}
          showAll={showAll}
          onShowAll={() => setShowAll(true)}
          onOpen={(aid) => {
            setActionId(aid);
            setRunServerId(serverId);
            setFinished(null);
            // запуск - в адрес: после перезагрузки откроется он, а не прошлый
            void navigate({
              to: '/commands/$id',
              params: { id },
              search: { server: serverId, run: aid, tab: 'output' },
              replace: true,
            });
          }}
        />
      )}
    </>
  );
}
