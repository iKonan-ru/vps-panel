import { ActionOutput } from '@/components/action-output';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { ServerStatusChip } from '@/components/server-status';
import { ActiveActions } from '@/components/server/active-actions';
import { AwgTab } from '@/components/server/awg/awg-tab';
import { BackupsTab } from '@/components/server/backups-tab';
import { CertsTab } from '@/components/server/certs/certs-tab';
import { DockerTab } from '@/components/server/docker-tab';
import { FirewallTab } from '@/components/server/firewall-tab';
import { InstallAgent } from '@/components/server/install-agent';
import { IpChangeDialog } from '@/components/server/ip-change-dialog';
import { LogTab } from '@/components/server/log-tab';
import { MtproxylTab } from '@/components/server/mtproxyl/mtproxyl-tab';
import { OpenfluxTab } from '@/components/server/openflux-tab';
import { OverviewTab } from '@/components/server/overview-tab';
import { RebootDialog } from '@/components/server/reboot-dialog';
import { SshKeysTab } from '@/components/server/ssh-keys-tab';
import { WdttTab } from '@/components/server/wdtt-tab';
import { XuiTab } from '@/components/server/xui-tab';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { Section } from '@/components/ui/section';
import { Tabs } from '@/components/ui/tabs';
import { actions } from '@/lib/actions';
import { loadChunk } from '@/lib/chunk';
import { cn } from '@/lib/cn';
import { agentVersionShort, cap, uptime } from '@/lib/format';
import { serverLock, useServer } from '@/lib/servers';
import { useCopy } from '@/lib/use-copy';
import { useQueryClient } from '@tanstack/react-query';
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
  Wand2,
  Wrench,
  X,
} from 'lucide-react';
import { type FormEvent, Suspense, lazy, useState } from 'react';

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
  // вкладка живёт в адресе: /servers/<id>/<tab>; неизвестная или недоступная (сервиса на
  // сервере нет) - обзор
  // вкладка OpenFlux открывается и без OpenFlux на сервере (из обзора: "Новый канал" ставит его),
  // но в ряду вкладок её тогда нет
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
  const [rename, setRename] = useState(false);
  const [reinstall, setReinstall] = useState(false);
  const [remove, setRemove] = useState(false);
  const [agentMsg, setAgentMsg] = useState<string | null>(null);
  const [agentBusy, setAgentBusy] = useState(false);
  // действие обновления агента, запущенное с этой страницы: показываем его ход под шапкой
  const [agentAction, setAgentAction] = useState<string | null>(null);
  const [agentRunning, setAgentRunning] = useState(false);

  async function updateAgent() {
    if (!s) return;
    setAgentBusy(true);
    setAgentMsg(null);
    try {
      const r = await actions.agentUpdate(s.id);
      setAgentAction(r.actionId);
      setAgentRunning(true);
    } catch (e) {
      setAgentMsg(`Не удалось обновить агент: ${(e as Error).message}`);
    } finally {
      setAgentBusy(false);
    }
  }

  if (isLoading) return <Card className="p-8 text-muted">Загрузка&hellip;</Card>;
  if (error || !s)
    return <Card className="p-8 text-bad">{cap(error?.message ?? 'сервер не найден')}</Card>;
  const inv = s.inventory;
  const online = s.status === 'online';
  const lock = serverLock(s);

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
                  {s.agentUpdating ? (
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
              icon: (
                <RefreshCw
                  className={cn(
                    'size-4',
                    (agentBusy || agentRunning || s.agentUpdating) && 'animate-spin',
                  )}
                />
              ),
              onClick: () => void updateAgent(),
              disabled: !online || lock.busy || agentBusy || s.agentUpdating || agentRunning,
              title: lock.reason,
              // на узком экране кнопкой - только когда есть что обновлять
              mobile: Boolean(s.agentUpdateAvailable || s.agentUpdating || agentRunning),
            },
            {
              key: 'setup',
              label: 'Настроить сервер',
              icon: <Wand2 className="size-4" />,
              onClick: () =>
                void navigate({
                  to: '/servers/$id/setup',
                  params: { id },
                  search: { backup: undefined },
                }),
              disabled: !online || lock.busy || agentBusy || s.agentUpdating || agentRunning,
              title: lock.reason ?? 'Ключ панели, безопасность, сервисы и клиенты одним действием',
            },
            {
              key: 'reinstall',
              label: 'Переустановить агент',
              icon: <Wrench className="size-4" />,
              onClick: () => setReinstall(true),
              // переустановка - и для зависшего агента, но не поверх своего обновления
              disabled: agentBusy || agentRunning || s.agentUpdating,
            },
            {
              key: 'ip',
              label: 'Сменить IP-адрес',
              icon: <ArrowLeftRight className="size-4" />,
              title: lock.reason ?? 'Перевести сервер на новый адрес от хостера',
              onClick: () => setIpChange(true),
              disabled: lock.busy || agentBusy || agentRunning || s.agentUpdating,
            },
            {
              key: 'reboot',
              label: 'Перезагрузить сервер',
              icon: <Power className="size-4" />,
              onClick: () => setReboot(true),
              disabled: !online || lock.busy || agentBusy || agentRunning || s.agentUpdating,
              title: lock.reason,
            },
            {
              key: 'remove',
              label: 'Удалить из панели',
              icon: <Trash2 className="size-4" />,
              onClick: () => setRemove(true),
              disabled: lock.busy || agentBusy || agentRunning || s.agentUpdating,
              title: lock.reason,
              variant: 'danger',
              group: 'danger',
            },
          ]}
        />
      </div>

      <Tabs items={available} value={tab} onChange={setTab} />

      {agentMsg && (
        <Alert tone={agentMsg.startsWith('Не удалось') ? 'bad' : 'ok'}>{agentMsg}</Alert>
      )}
      {agentAction && (
        <Section
          title="Обновление агента"
          actions={
            <>
              {agentRunning && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => {
                    setAgentMsg(null);
                    actions
                      .agentUpdateCancel(s.id)
                      .catch((e: Error) => setAgentMsg(`Не удалось отменить: ${e.message}`));
                  }}
                  label="Отменить"
                >
                  <X className="size-3.5" />
                </Button>
              )}
              {/* скрыть - после конца: вывод держит и признак "обновляется" (onFinished) */}
              {!agentRunning && (
                <Button size="sm" onClick={() => setAgentAction(null)} label="Скрыть">
                  <X className="size-3.5" />
                </Button>
              )}
            </>
          }
        >
          <div className="p-4">
            <ActionOutput actionId={agentAction} onFinished={() => setAgentRunning(false)} />
          </div>
        </Section>
      )}
      {!online && s.status !== 'no-agent' && tab !== 'log' && (
        <Alert>
          {s.agentUpdating
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
          <Suspense fallback={<Card className="p-8 text-[13px] text-muted">Загрузка&hellip;</Card>}>
            <TerminalTab s={s} />
          </Suspense>
        )}
        {tab === 'keys' && <SshKeysTab s={s} />}
        {tab === 'log' && <LogTab serverId={s.id} />}
      </div>

      <RebootDialog serverId={s.id} name={s.name} open={reboot} onClose={() => setReboot(false)} />
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

function RenameDialog({
  serverId,
  name,
  open,
  onClose,
}: { serverId: string; name: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(name);
  const [error, setError] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await actions.patchServer(serverId, { name: v.trim() });
      await qc.invalidateQueries({ queryKey: ['servers'] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Переименовать">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Имя сервера" htmlFor="rn-name">
          <Input
            id="rn-name"
            value={v}
            onChange={(e) => setV(e.target.value)}
            required
            maxLength={64}
          />
        </Field>
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary">
            Сохранить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ReinstallDialog({
  serverId,
  host,
  open,
  onClose,
}: { serverId: string; host: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  return (
    <Dialog open={open} onClose={onClose} title="Переустановка агента" wide>
      <div className="text-sm text-muted">Сервисы на сервере продолжат работать</div>
      <InstallAgent
        serverId={serverId}
        host={host}
        onDone={() => qc.invalidateQueries({ queryKey: ['servers'] })}
      />
    </Dialog>
  );
}

function RemoveDialog({
  serverId,
  name,
  open,
  onClose,
}: { serverId: string; name: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function go() {
    if (busy) return;
    setBusy(true);
    try {
      await actions.deleteServer(serverId);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    // сначала уходим со страницы сервера: перезапрос удалённого сервера (404 с повторами) держал
    // бы окно открытым; потом убираем его из кэша и обновляем список
    await nav({ to: '/' });
    qc.removeQueries({ queryKey: ['servers', serverId] });
    void qc.invalidateQueries({ queryKey: ['servers'], exact: true });
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Удалить \u00ab${name}\u00bb из панели?`}>
      <div className="text-sm text-muted">
        Журнал и ручные правила firewall удалятся из панели. На самом сервере ничего не изменится.
      </div>
      <Field
        label={
          <>
            Имя для подтверждения: <span className="font-mono">{name}</span>
          </>
        }
        htmlFor="rm-name"
      >
        <Input
          id="rm-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="danger" disabled={typed !== name || busy} onClick={go}>
          Удалить
        </Button>
      </div>
    </Dialog>
  );
}
