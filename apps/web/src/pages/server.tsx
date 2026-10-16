import { ActionOutput } from '@/components/action-output';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ServerStatusChip } from '@/components/server-status';
import { ActiveActions } from '@/components/server/active-actions';
import { AwgTab } from '@/components/server/awg/awg-tab';
import { BackupsTab } from '@/components/server/backups-tab';
import { CertsTab } from '@/components/server/certs/certs-tab';
import { DockerTab } from '@/components/server/docker-tab';
import { FirewallTab } from '@/components/server/firewall-tab';
import { IpChangeDialog } from '@/components/server/ip-change-dialog';
import { LogTab } from '@/components/server/log-tab';
import { MigrateDialog } from '@/components/server/migrate-dialog';
import { MtproxylTab } from '@/components/server/mtproxyl/mtproxyl-tab';
import { OpenfluxTab } from '@/components/server/openflux-tab';
import { OverviewTab } from '@/components/server/overview-tab';
import { RebootDialog } from '@/components/server/reboot-dialog';
import { ReinstallDialog, RemoveDialog, RenameDialog } from '@/components/server/server-dialogs';
import { SshKeysTab } from '@/components/server/ssh-keys-tab';
import { WdttTab } from '@/components/server/wdtt-tab';
import { XuiTab } from '@/components/server/xui-tab';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { PageTitle } from '@/components/ui/page-title';
import { LoadState } from '@/components/ui/placeholder';
import { Section } from '@/components/ui/section';
import { Tabs } from '@/components/ui/tabs';
import { actions } from '@/lib/actions';
import { loadChunk } from '@/lib/chunk';
import { cn } from '@/lib/cn';
import { agentVersionShort, cap, uptime } from '@/lib/format';
import { serverLock, useServer } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useCopy } from '@/lib/use-copy';
import { useNavigate, useParams } from '@tanstack/react-router';
import { cpuModelLabel } from '@vps/protocol';
import {
  ArrowLeftRight,
  Check,
  Copy,
  Pencil,
  Power,
  RefreshCw,
  Trash2,
  Truck,
  Wand2,
  Wrench,
  X,
} from 'lucide-react';
import { Suspense, lazy, useState } from 'react';

// терминал (xterm, около 300 КБ) - отдельным куском, по открытию вкладки
const TerminalTab = lazy(() =>
  loadChunk(() => import('@/components/server/terminal-tab')).then((m) => ({
    default: m.TerminalTab,
  })),
);

type Tab =
  | 'overview'
  | 'firewall'
  | 'docker'
  | 'certs'
  | 'backups'
  | 'xui'
  | 'mtproxyl'
  | 'awg'
  | 'wdtt'
  | 'openflux'
  | 'terminal'
  | 'keys'
  | 'log';
/** Вкладки адаптеров (3x-ui, MTProxyL) показываются, только если агент нашёл сервис. */
const tabs: { id: Tab; title: string; service?: string }[] = [
  { id: 'overview', title: 'Обзор' },
  { id: 'xui', title: '3X-UI', service: 'xui' },
  { id: 'mtproxyl', title: 'MTProxyL', service: 'mtproxyl' },
  { id: 'awg', title: 'AWG', service: 'amnezia' },
  { id: 'wdtt', title: 'WDTT', service: 'wdtt' },
  { id: 'openflux', title: 'OpenFlux', service: 'openflux' },
  { id: 'docker', title: 'Docker' },
  { id: 'terminal', title: 'Терминал' },
  { id: 'keys', title: 'Ключи' },
  { id: 'firewall', title: 'Firewall' },
  { id: 'certs', title: 'Сертификаты' },
  { id: 'backups', title: 'Резервные копии' },
  { id: 'log', title: 'Журнал' },
];

/** Карточка сервера: шапка с действиями и вкладки (вкладки сервисов - если сервис есть). */
export function ServerPage() {
  const params = useParams({ strict: false }) as { id: string; tab?: string };
  const id = params.id;
  const navigate = useNavigate();
  const { data: s, isLoading, error } = useServer(id);
  // вкладка - в адресе; неизвестная или без сервиса на сервере - обзор. OpenFlux открывается и
  // без него ("Новый канал" из обзора ставит его), но в ряду вкладок его тогда нет
  const available = s
    ? tabs.filter(
        (t) =>
          !t.service ||
          s.services.some((x) => x.kind === t.service) ||
          (t.id === 'openflux' && params.tab === 'openflux'),
      )
    : tabs;
  const tab: Tab = available.some((t) => t.id === params.tab) ? (params.tab as Tab) : 'overview';
  const setTab = (t: Tab) =>
    void navigate({ to: '/servers/$id/$tab', params: { id, tab: t }, replace: false });
  const [reboot, setReboot] = useState(false);
  const [ipChange, setIpChange] = useState(false);
  const [migrate, setMigrate] = useState(false);
  const [rename, setRename] = useState(false);
  const [reinstall, setReinstall] = useState(false);
  const [remove, setRemove] = useState(false);
  const agentStart = useAction();
  const agentCancel = useAction();
  // обновление агента, запущенное с этой страницы: его ход - под шапкой; done - вывод закончился
  const [agentAction, setAgentAction] = useState<{ id: string; done: boolean } | null>(null);

  async function updateAgent() {
    if (!s) return;
    agentCancel.setError(null);
    await agentStart.run(async () => {
      const r = await actions.agentUpdate(s.id);
      setAgentAction({ id: r.actionId, done: false });
    });
  }

  if (isLoading) return <Card className="p-8 text-muted">Загрузка&hellip;</Card>;
  if (error || !s)
    return <Card className="p-8 text-bad">{cap(error?.message ?? 'сервер не найден')}</Card>;
  const inv = s.inventory;
  const online = s.status === 'online';
  const lock = serverLock(s);
  // агент обновляется: запуск, своё обновление до конца вывода или обновление по данным панели
  const agentUpdating =
    agentStart.busy || (agentAction !== null && !agentAction.done) || s.agentUpdating;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Серверы', to: '/' }, { label: s.name }]} />

      <div className="flex flex-wrap items-start gap-4">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex items-center gap-3">
            <PageTitle hero>{s.name}</PageTitle>
            <ServerStatusChip s={s} />
            {s.panelHost && (
              <Chip tone="accent" title="Сервер панели">
                панель
              </Chip>
            )}
            <Button
              size="sm"
              variant="ghost"
              aria-label="Переименовать"
              onClick={() => setRename(true)}
            >
              <Pencil className="size-3.5" />
            </Button>
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] leading-7 text-muted [&>*]:inline-flex [&>*]:h-7 [&>*]:items-center">
            <CopyText text={s.host} />
            <span>SSH {s.sshPort}</span>
            {inv && (
              <>
                <span>{inv.host.os}</span>
                <span>ядро {inv.host.kernel}</span>
                {cpuModelLabel(inv.host.cpuModel) && (
                  <span title={inv.host.cpuModel}>{cpuModelLabel(inv.host.cpuModel)}</span>
                )}
                <span title={inv.host.agentVersion} className="gap-1.5">
                  агент {agentVersionShort(s.agentVersion ?? inv.host.agentVersion)}
                  {agentUpdating ? (
                    <Chip tone="update" dot pulse className="text-[11px]">
                      обновляется
                    </Chip>
                  ) : (
                    s.agentUpdateAvailable && (
                      <Chip tone="warn" className="text-[11px]">
                        есть обновление
                      </Chip>
                    )
                  )}
                </span>
              </>
            )}
            {s.metrics && <span>аптайм {uptime(s.metrics.uptimeSec)}</span>}
          </div>
        </div>
        <div className="grow" />
        <ActionBar
          size="md"
          topbar
          actions={[
            {
              key: 'agent',
              label: 'Обновить агент',
              icon: <RefreshCw className={cn('size-4', agentUpdating && 'animate-spin')} />,
              onClick: () => void updateAgent(),
              disabled: !online || lock.busy || agentUpdating,
              title: lock.reason,
              // на узком экране кнопкой - только когда есть что обновлять
              mobile: Boolean(s.agentUpdateAvailable || agentUpdating),
            },
            {
              key: 'setup',
              label: 'Настроить сервер',
              icon: <Wand2 className="size-4" />,
              onClick: () =>
                void navigate({
                  to: '/servers/$id/setup',
                  params: { id },
                  search: { backup: undefined, migrate: undefined, wipe: undefined },
                }),
              disabled: !online || lock.busy || agentUpdating,
              title: lock.reason ?? 'Ключ панели, безопасность, сервисы и клиенты одним действием',
            },
            {
              key: 'migrate',
              label: 'Перенести на другой сервер',
              icon: <Truck className="size-4" />,
              onClick: () => setMigrate(true),
              // старый сервер может быть уже недоступен: перенос - из его копии
              disabled: lock.busy || agentUpdating,
              title: lock.reason ?? 'Сервисы, данные и клиенты\u00a0\u2014 на другой сервер панели',
            },
            {
              key: 'reinstall',
              label: 'Переустановить агент',
              icon: <Wrench className="size-4" />,
              onClick: () => setReinstall(true),
              // переустановка - и для зависшего агента, но не поверх своего обновления
              disabled: agentUpdating,
            },
            {
              key: 'ip',
              label: 'Сменить IP-адрес',
              icon: <ArrowLeftRight className="size-4" />,
              title: lock.reason ?? 'Перевести сервер на новый адрес от хостера',
              onClick: () => setIpChange(true),
              disabled: lock.busy || agentUpdating,
            },
            {
              key: 'reboot',
              label: 'Перезагрузить сервер',
              icon: <Power className="size-4" />,
              onClick: () => setReboot(true),
              disabled: !online || lock.busy || agentUpdating,
              title: lock.reason,
            },
            {
              key: 'remove',
              label: 'Удалить из панели',
              icon: <Trash2 className="size-4" />,
              onClick: () => setRemove(true),
              disabled: lock.busy || agentUpdating,
              title: lock.reason,
              variant: 'danger',
              group: 'danger',
            },
          ]}
        />
      </div>

      <Tabs items={available} value={tab} onChange={setTab} />

      {agentStart.error && <Alert tone="bad">Не удалось обновить агент: {agentStart.error}</Alert>}
      {agentCancel.error && <Alert tone="bad">Не удалось отменить: {agentCancel.error}</Alert>}
      {agentAction && (
        <Section
          title="Обновление агента"
          actions={
            <>
              {!agentAction.done && (
                <Button
                  size="sm"
                  variant="danger"
                  disabled={agentCancel.busy}
                  onClick={() => void agentCancel.run(() => actions.agentUpdateCancel(s.id))}
                  label="Отменить"
                >
                  <X className="size-3.5" />
                </Button>
              )}
              {/* скрыть - после конца: вывод держит признак "обновляется" (onFinished) */}
              {agentAction.done && (
                <Button size="sm" onClick={() => setAgentAction(null)} label="Скрыть">
                  <X className="size-3.5" />
                </Button>
              )}
            </>
          }
        >
          <div className="p-4">
            <ActionOutput
              actionId={agentAction.id}
              onFinished={() => setAgentAction((a) => (a ? { ...a, done: true } : a))}
            />
          </div>
        </Section>
      )}
      {!online && s.status !== 'no-agent' && tab !== 'log' && (
        <Alert>
          {agentUpdating
            ? 'Агент обновляется, связь восстановится через несколько секунд'
            : 'Сервер не в сети: показаны последние данные, действия недоступны'}
        </Alert>
      )}
      <ActiveActions s={s} />
      {s.status === 'no-agent' && tab !== 'log' && (
        <Alert>
          Агент ещё не подключался. Установить его можно через &laquo;Переустановить агент&raquo;.
        </Alert>
      )}

      {/* вкладка появляется плавно; только прозрачность - у терминала на весь экран fixed */}
      <div key={tab} className="flex animate-fade-in flex-col gap-5 [&>*]:shrink-0">
        {tab === 'overview' && <OverviewTab s={s} onTab={(t) => setTab(t as Tab)} />}
        {tab === 'firewall' && <FirewallTab s={s} />}
        {tab === 'docker' && <DockerTab s={s} />}
        {tab === 'certs' && <CertsTab s={s} />}
        {tab === 'backups' && <BackupsTab s={s} />}
        {tab === 'xui' && <XuiTab s={s} />}
        {tab === 'mtproxyl' && <MtproxylTab s={s} />}
        {tab === 'awg' && <AwgTab s={s} />}
        {tab === 'wdtt' && <WdttTab s={s} />}
        {tab === 'openflux' && <OpenfluxTab s={s} />}
        {tab === 'terminal' && (
          <Suspense fallback={<LoadState />}>
            <TerminalTab s={s} />
          </Suspense>
        )}
        {tab === 'keys' && <SshKeysTab s={s} />}
        {tab === 'log' && <LogTab serverId={s.id} />}
      </div>

      <RebootDialog serverId={s.id} name={s.name} open={reboot} onClose={() => setReboot(false)} />
      <MigrateDialog serverId={id} open={migrate} onClose={() => setMigrate(false)} />
      <IpChangeDialog
        serverId={s.id}
        host={s.host}
        open={ipChange}
        onClose={() => setIpChange(false)}
      />
      <RenameDialog serverId={s.id} name={s.name} open={rename} onClose={() => setRename(false)} />
      <ReinstallDialog
        serverId={s.id}
        host={s.host}
        open={reinstall}
        onClose={() => setReinstall(false)}
      />
      <RemoveDialog serverId={s.id} name={s.name} open={remove} onClose={() => setRemove(false)} />
    </>
  );
}

/** Адрес сервера: клик копирует в буфер обмена. */
function CopyText({ text }: { text: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button
      variant="link"
      title="Скопировать"
      className="gap-1 font-mono text-muted hover:text-text hover:no-underline"
      onClick={() => copy(text)}
    >
      {text}
      {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5 opacity-60" />}
    </Button>
  );
}
