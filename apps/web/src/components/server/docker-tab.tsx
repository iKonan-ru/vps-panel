import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import { actions } from '@/lib/actions';
import { type ServerDetail, serverLock } from '@/lib/servers';
import { useQueryClient } from '@tanstack/react-query';
import type { Container } from '@vps/protocol';
import { FileText, Play, RefreshCw, RotateCw, Square, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

const stateTone: Record<Container['state'], 'ok' | 'warn' | 'bad' | 'muted'> = {
  running: 'ok',
  restarting: 'warn',
  paused: 'warn',
  exited: 'muted',
  created: 'muted',
  removing: 'warn',
  dead: 'bad',
};

function isVpn(c: Container): boolean {
  return /amnezia|awg|wireguard|xray|3x-ui|x-ui|mtproxy|telemt|openvpn|shadowsocks/i.test(
    `${c.name} ${c.image}`,
  );
}

/** Вкладка Docker: контейнеры, старт/стоп/рестарт/удалить, логи. */
export function DockerTab({ s }: { s: ServerDetail }) {
  const qc = useQueryClient();
  const online = s.status === 'online';
  const containers = s.inventory?.containers ?? [];
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // занято: своё действие с контейнером или другое действие на сервере (логи доступны всегда)
  const pending = busy ?? serverLock(s).reason ?? null;
  const [confirm, setConfirm] = useState<{
    c: Container;
    action: 'stop' | 'restart' | 'remove';
  } | null>(null);
  const [logs, setLogs] = useState<Container | null>(null);

  async function run(c: Container, action: 'start' | 'stop' | 'restart' | 'remove') {
    setBusy(c.id);
    setError(null);
    try {
      await actions.docker(s.id, c.id, action);
      await qc.invalidateQueries({ queryKey: ['servers'] });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  function ask(c: Container, action: 'stop' | 'restart' | 'remove') {
    if (action === 'remove' || isVpn(c)) setConfirm({ c, action });
    else void run(c, action);
  }

  if (!s.inventory?.host.dockerVersion) {
    return <Card className="p-8 text-[13px] text-muted">Docker не установлен</Card>;
  }

  const groups = new Map<string, Container[]>();
  for (const c of containers) {
    const k = c.composeProject ?? '';
    groups.set(k, [...(groups.get(k) ?? []), c]);
  }

  return (
    <>
      {error && <Alert tone="bad">{error}</Alert>}
      <Section
        title="Контейнеры"
        extra={
          <>
            <Chip>{containers.length}</Chip>
            <Chip tone="ok">
              работает: {containers.filter((c) => c.state === 'running').length}
            </Chip>
            <span className="text-xs text-muted">docker {s.inventory.host.dockerVersion}</span>
          </>
        }
      >
        <div className="hidden md:block">
          <Table>
            <THead>
              <tr>
                <th>Имя</th>
                <th>Образ</th>
                <th>Состояние</th>
                <th>Порты</th>
                <th>CPU</th>
                <th>Память</th>
                <th />
              </tr>
            </THead>
            <TBody>
              {[...groups.entries()].map(([project, list]) => (
                <GroupRows
                  key={project || '_'}
                  project={project}
                  list={list}
                  online={online}
                  busy={pending}
                  onAction={(c, a) => (a === 'start' ? run(c, a) : ask(c, a))}
                  onLogs={setLogs}
                />
              ))}
              {containers.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-4 text-center text-muted">
                    Контейнеров нет
                  </td>
                </tr>
              )}
            </TBody>
          </Table>
        </div>
        <MobileList
          groups={groups}
          online={online}
          busy={pending}
          onAction={(c, a) => (a === 'start' ? run(c, a) : ask(c, a))}
          onLogs={setLogs}
        />
        {containers.length === 0 && (
          <div className="px-4 py-4 text-center text-muted md:hidden">Контейнеров нет</div>
        )}
      </Section>

      <Dialog
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm ? `${actionTitle(confirm.action)} \u00ab${confirm.c.name}\u00bb?` : ''}
      >
        {confirm && (
          <>
            <div className="flex flex-col gap-2 text-sm">
              {isVpn(confirm.c) && (
                <div className="text-warn">Похоже на VPN: клиенты потеряют соединение</div>
              )}
              {confirm.action === 'remove' && (
                <div className="text-muted">Тома и образ останутся</div>
              )}
            </div>
            <div className="flex justify-end gap-2">
              <Button onClick={() => setConfirm(null)}>Отмена</Button>
              <Button
                variant="danger"
                onClick={() => {
                  const { c, action } = confirm;
                  setConfirm(null);
                  void run(c, action);
                }}
              >
                {actionTitle(confirm.action)}
              </Button>
            </div>
          </>
        )}
      </Dialog>

      <LogsDialog serverId={s.id} container={logs} onClose={() => setLogs(null)} />
    </>
  );
}

function actionTitle(a: 'stop' | 'restart' | 'remove') {
  return { stop: 'Остановить', restart: 'Перезапустить', remove: 'Удалить контейнер' }[a];
}

function GroupRows({
  project,
  list,
  online,
  busy,
  onAction,
  onLogs,
}: {
  project: string;
  list: Container[];
  online: boolean;
  busy: string | null;
  onAction: (c: Container, a: 'start' | 'stop' | 'restart' | 'remove') => unknown;
  onLogs: (c: Container) => void;
}) {
  return (
    <>
      {project && (
        <tr>
          <td colSpan={7} className="bg-surface-2/50 py-1.5 text-xs text-muted">
            compose: {project}
          </td>
        </tr>
      )}
      {list.map((c) => {
        return (
          <tr key={c.id}>
            <td className="whitespace-nowrap font-medium">
              {c.name}
              {isVpn(c) && (
                <Chip tone="warn" className="ml-2 align-middle">
                  VPN
                </Chip>
              )}
            </td>
            <td className="max-w-[260px] truncate font-mono text-xs text-muted" title={c.image}>
              {c.image}
            </td>
            <td>
              <Chip tone={stateTone[c.state]} dot>
                {c.state}
              </Chip>
              <div className="mt-0.5 text-xs text-muted">{c.status}</div>
            </td>
            <td className="font-mono text-xs">
              {c.published.join(', ') || (
                <span className="text-muted">{c.networkMode === 'host' ? 'host' : '-'}</span>
              )}
            </td>
            <td className="font-mono text-xs">
              {c.cpuPercent !== undefined ? `${c.cpuPercent.toFixed(1).replace('.', ',')}%` : '-'}
            </td>
            <td className="font-mono text-xs">
              {c.memMb !== undefined ? `${Math.round(c.memMb)} МБ` : '-'}
            </td>
            <td>
              <ContainerActions
                c={c}
                online={online}
                busy={busy}
                onAction={onAction}
                onLogs={onLogs}
                className="justify-end"
              />
            </td>
          </tr>
        );
      })}
    </>
  );
}

type ActionProps = {
  online: boolean;
  busy: string | null;
  onAction: (c: Container, a: 'start' | 'stop' | 'restart' | 'remove') => unknown;
  onLogs: (c: Container) => void;
};

/** Кнопки контейнера: в строке таблицы и в карточке на мобиле. */
function ContainerActions({
  c,
  online,
  busy,
  onAction,
  onLogs,
  className,
}: ActionProps & { c: Container; className?: string }) {
  const running = c.state === 'running';
  const dis = !online || busy !== null;
  return (
    <ActionBar
      dense
      {...(className ? { className } : {})}
      actions={[
        {
          key: 'logs',
          label: 'Логи',
          icon: <FileText className="size-3.5" />,
          disabled: !online,
          onClick: () => onLogs(c),
          mobile: true,
        },
        {
          key: 'stop',
          label: 'Остановить',
          icon: <Square className="size-3.5" />,
          hidden: !running,
          disabled: dis,
          onClick: () => onAction(c, 'stop'),
        },
        {
          key: 'restart',
          label: 'Перезапустить',
          icon: <RotateCw className="size-3.5" />,
          hidden: !running,
          disabled: dis,
          onClick: () => onAction(c, 'restart'),
        },
        {
          key: 'start',
          label: 'Запустить',
          icon: <Play className="size-3.5" />,
          hidden: running,
          disabled: dis,
          onClick: () => onAction(c, 'start'),
        },
        {
          key: 'remove',
          label: 'Удалить контейнер',
          icon: <Trash2 className="size-3.5" />,
          variant: 'danger',
          group: 'danger',
          disabled: dis,
          onClick: () => onAction(c, 'remove'),
        },
      ]}
    />
  );
}

/** Контейнеры на мобиле: список внутри карточки вместо широкой таблицы. */
function MobileList({ groups, ...actions }: ActionProps & { groups: Map<string, Container[]> }) {
  return (
    <div className="divide-y divide-border md:hidden">
      {[...groups.entries()].map(([project, list]) => (
        <div key={project || '-'} className="divide-y divide-border">
          {project && (
            <div className="bg-surface-2/50 px-4 py-1.5 text-xs text-muted">compose: {project}</div>
          )}
          {list.map((c) => (
            <div key={c.id} className="flex flex-col gap-1.5 px-4 py-3">
              <div className="flex items-center gap-2">
                <span className="min-w-0 truncate font-medium">{c.name}</span>
                {isVpn(c) && <Chip tone="warn">VPN</Chip>}
                <div className="grow" />
                <Chip tone={stateTone[c.state]} dot>
                  {c.state}
                </Chip>
              </div>
              <div className="truncate font-mono text-xs text-muted" title={c.image}>
                {c.image}
              </div>
              <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-muted">
                <span>{c.status}</span>
                <span className="font-mono">
                  {c.published.join(', ') || (c.networkMode === 'host' ? 'host' : 'без портов')}
                </span>
                {c.cpuPercent !== undefined && (
                  <span>CPU {c.cpuPercent.toFixed(1).replace('.', ',')}%</span>
                )}
                {c.memMb !== undefined && <span>{Math.round(c.memMb)} МБ</span>}
              </div>
              <ContainerActions c={c} {...actions} className="-ml-2" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function LogsDialog({
  serverId,
  container,
  onClose,
}: { serverId: string; container: Container | null; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tail, setTail] = useState(500);
  // "Обновить" - тот же запрос заново (setTail(t => t) состояние не меняет и эффект не будит)
  const [reload, setReload] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reload - счётчик нажатий "Обновить"
  useEffect(() => {
    if (!container) return;
    setText(null);
    setError(null);
    actions
      .dockerLogs(serverId, container.id, tail)
      .then((r) => setText(r.text))
      .catch((e: Error) => setError(e.message));
  }, [serverId, container, tail, reload]);
  return (
    <Dialog
      open={container !== null}
      onClose={onClose}
      title={container ? `Логи: ${container.name}` : ''}
      wide
    >
      {error && <Alert tone="bad">{error}</Alert>}
      <pre className="max-h-[60vh] min-h-[200px] overflow-auto console rounded-lg p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
        {text === null ? 'Загрузка\u2026' : text || 'Логов нет'}
      </pre>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted">Последние строки:</span>
        {[200, 500, 2000].map((n) => (
          <Button
            key={n}
            size="sm"
            variant={tail === n ? 'default' : 'ghost'}
            onClick={() => setTail(n)}
          >
            {n}
          </Button>
        ))}
        <div className="grow" />
        <Button size="sm" onClick={() => setReload((n) => n + 1)} label="Обновить">
          <RefreshCw className="size-3.5" />
        </Button>
      </div>
    </Dialog>
  );
}
