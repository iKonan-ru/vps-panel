import { Breadcrumbs } from '@/components/breadcrumbs';
import { ClientWatchDialog, useClientWatchCount } from '@/components/client-watch';
import { BindingPill, byServer, pillLabel } from '@/components/clients/binding-pill';
import { BindingStates, deviceTitle } from '@/components/clients/binding-states';
import {
  AccessForm,
  DeviceForm,
  ProxyLinks,
  RenameForm,
} from '@/components/clients/client-dialogs';
import { LiveSummary, ServerOnlineMark, useClientLive } from '@/components/clients/live-stats';
import { SyncPanel } from '@/components/clients/sync-panel';
import { ClientConfig } from '@/components/links/awg-config';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { InfoTip } from '@/components/ui/info-tip';
import { LinkButton } from '@/components/ui/link-button';
import { PageTitle } from '@/components/ui/page-title';
import { LoadState } from '@/components/ui/placeholder';
import { QrCode } from '@/components/ui/qr-code';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { type GBinding, type GClientDetail, type GDevice, serviceByBinding } from '@vps/protocol';
import {
  Bell,
  ExternalLink,
  KeyRound,
  Pencil,
  Plus,
  Power,
  RefreshCw,
  SlidersHorizontal,
  Trash2,
} from 'lucide-react';
import { useState } from 'react';

/** Карточка глобального клиента: устройства, привязки по серверам, вкл/выкл, удаление. */
export function ClientPage() {
  const { id } = useParams({ from: '/app/clients/$id' });
  const qc = useQueryClient();
  const ask = useConfirm();
  const navigate = useNavigate();
  const { data, error } = useQuery({
    queryKey: ['gclient', id],
    queryFn: () => api<GClientDetail>(`/api/gclients/${id}`),
    // пока идёт сверка - чаще: кнопка "Сверить сейчас" ждёт её конца
    refetchInterval: (q) => (q.state.data?.syncing ? 2_000 : 10_000),
  });
  // от нажатия до ответа: сверка уже запущена, а свежей карточки ещё нет
  const [syncAsked, setSyncAsked] = useState(false);
  const [rename, setRename] = useState(false);
  const [accessOpen, setAccessOpen] = useState(false);
  const [device, setDevice] = useState<GDevice | 'new' | null>(null);
  const [awgConfigBinding, setAwgConfigBinding] = useState<GBinding | null>(null);
  const [linksBinding, setLinksBinding] = useState<GBinding | null>(null);
  const [qr, setQr] = useState(false);
  const [watchOpen, setWatchOpen] = useState(false);
  const watchCount = useClientWatchCount(id);
  const refresh = () => qc.invalidateQueries({ queryKey: ['gclient', id] });
  const live = useClientLive(id, data?.bindings ?? []);

  // пока идёт правка клиента, его кнопки недоступны (двойной тап по вкл/выкл - два запроса)
  const op = useAction();
  async function call(fn: () => Promise<unknown>) {
    await op.run(async () => {
      await fn();
      await refresh();
    });
  }

  async function sync() {
    setSyncAsked(true);
    await call(() => api('/api/gclients/sync', { method: 'POST', json: { clientId: id } }));
    setSyncAsked(false);
  }

  if (error || !data) return <LoadState error={error} />;
  const c = data.client;
  const syncing = syncAsked || data.syncing;

  return (
    <>
      <Breadcrumbs items={[{ label: 'Клиенты', to: '/clients' }, { label: c.name }]} />
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>{c.name}</PageTitle>
        {c.enabled ? <Chip tone="ok">включён</Chip> : <Chip tone="muted">выключен</Chip>}
        <div className="grow" />
        <ActionBar
          topbar
          actions={[
            {
              key: 'page',
              label: 'Личная страница',
              icon: <ExternalLink className="size-3.5" />,
              href: data.subscription.page,
              node: (
                <LinkButton
                  href={data.subscription.page}
                  variant="primary"
                  title="Подписка, прокси, конфиги и приложения клиента на одной странице"
                  copyTitle="Скопировать ссылку на личную страницу"
                >
                  Личная страница
                </LinkButton>
              ),
              mobile: true,
              group: 'page',
            },
            {
              key: 'rotate',
              label: 'Новая ссылка',
              icon: <KeyRound className="size-3.5" />,
              title: 'Перевыпустить ссылки на подписку и личную страницу',
              onClick: async () => {
                const ok = await ask({
                  title: `Перевыпустить ссылки для ${c.name}?`,
                  text: 'Старые ссылки на подписку и личную страницу перестанут работать: подписка в приложениях клиента не будет обновляться до добавления новой. Подключения на серверах не изменятся.',
                  okLabel: 'Перевыпустить',
                  danger: true,
                });
                if (!ok) return;
                await call(() => api(`/api/gclients/${id}/rotate-token`, { method: 'POST' }));
              },
            },
            {
              key: 'rename',
              label: 'Переименовать',
              icon: <Pencil className="size-3.5" />,
              onClick: () => setRename(true),
            },
            {
              key: 'toggle',
              label: c.enabled ? 'Выключить клиента' : 'Включить клиента',
              icon: <Power className="size-3.5" />,
              disabled: op.busy || syncing,
              onClick: () =>
                void call(() =>
                  api(`/api/gclients/${id}`, { method: 'PATCH', json: { enabled: !c.enabled } }),
                ),
            },
            {
              key: 'remove',
              label: 'Удалить клиента',
              icon: <Trash2 className="size-3.5" />,
              variant: 'danger',
              group: 'danger',
              disabled: op.busy || syncing,
              onClick: async () => {
                const ok = await ask({
                  title: `Удалить клиента ${c.name}?`,
                  text: 'Все его подключения будут удалены с серверов, подписка и конфиги перестанут работать.',
                  okLabel: 'Удалить',
                  danger: true,
                });
                if (!ok) return;
                await call(async () => {
                  await api(`/api/gclients/${id}`, { method: 'DELETE' });
                  await qc.invalidateQueries({ queryKey: ['gclients'] });
                  await navigate({ to: '/clients' });
                });
              },
            },
          ]}
        />
      </div>
      {c.note && <div className="text-[13px] text-muted">{c.note}</div>}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <SyncPanel />

      {data.subscription.temporary && (
        <Alert tone="info">
          Ссылки временные, на адресе панели: после настройки SUB_DOMAIN они изменятся. Клиентам их
          пока не раздавать.
        </Alert>
      )}
      {!c.enabled && <Alert tone="info">Клиент выключен: подписка отдаёт пустой список</Alert>}
      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <Section
            title="Устройства"
            extra={<Chip>{data.devices.length}</Chip>}
            actions={
              <Button size="sm" onClick={() => setDevice('new')} label="Добавить">
                <Plus className="size-3.5" />
              </Button>
            }
          >
            {data.devices.length === 0 && (
              <div className="px-4 py-3 text-[13px] text-muted">
                Устройств нет: AWG заводится на каждое устройство
              </div>
            )}
            {data.devices.map((d) => (
              <div
                key={d.id}
                className="flex items-center gap-1 border-b border-border py-1.5 pr-2 pl-4 last:border-b-0"
              >
                <span className="min-w-0 grow truncate text-[13px]">{deviceTitle(d)}</span>
                {d.awg20 && <Chip>AWG 2.0</Chip>}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Изменить"
                  onClick={() => setDevice(d)}
                >
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Удалить устройство"
                  onClick={async () => {
                    const ok = await ask({
                      title: `Удалить устройство ${deviceTitle(d)}?`,
                      text: 'Его конфиги AWG на всех серверах перестанут работать.',
                      okLabel: 'Удалить',
                      danger: true,
                    });
                    if (ok)
                      await call(() =>
                        api(`/api/gclients/${id}/devices/${d.id}`, { method: 'DELETE' }),
                      );
                  }}
                >
                  <Trash2 className="size-3.5 text-bad" />
                </Button>
              </div>
            ))}
          </Section>
        </div>

        <Section
          title="Серверы"
          extraBelow
          extra={
            <>
              <BindingStates
                s={{
                  ok: data.bindings.filter((b) => b.state === 'ok').length,
                  pending: data.bindings.filter((b) => b.state === 'pending').length,
                  error: data.bindings.filter((b) => b.state === 'error').length,
                }}
              />
              <LiveSummary live={live} />
              {c.access !== null && <Chip tone="accent">выборочный доступ</Chip>}
              {syncing && <span className="text-xs text-muted">идёт синхронизация</span>}
            </>
          }
          actions={
            <ActionBar
              actions={[
                {
                  key: 'access',
                  label: 'Доступ',
                  icon: <SlidersHorizontal className="size-3.5" />,
                  title: 'Серверы и сервисы клиента',
                  onClick: () => setAccessOpen(true),
                },
                {
                  key: 'watch',
                  label: watchCount ? `Уведомления: ${watchCount}` : 'Уведомления',
                  icon: <Bell className="size-3.5" />,
                  title: 'Уведомления в Telegram о подключении клиента',
                  onClick: () => setWatchOpen(true),
                },
                {
                  key: 'sync',
                  label: 'Синхронизировать',
                  icon: <RefreshCw className={cn('size-3.5', syncing && 'animate-spin')} />,
                  disabled: syncing,
                  title: syncing ? undefined : 'Полная синхронизация клиента на всех серверах',
                  onClick: () => void sync(),
                },
              ]}
            />
          }
        >
          {data.bindings.length === 0 && (
            <div className="px-4 py-3 text-[13px] text-muted">
              {c.access?.length === 0
                ? 'Доступ не выдан ни к одному сервису'
                : 'Пока ничего не заведено: синхронизация обычно занимает до минуты'}
            </div>
          )}
          {byServer(data.bindings).map(([serverId, list]) => (
            <div
              key={serverId}
              className="flex flex-col gap-2 border-b border-border px-4 py-2.5 last:border-b-0 sm:flex-row sm:items-start sm:gap-3"
            >
              <div className="flex shrink-0 flex-wrap items-center gap-2 sm:w-32 sm:flex-col sm:items-start sm:gap-1">
                <Link
                  to="/clients/$id/servers/$serverId"
                  params={{ id, serverId }}
                  title="Подключение и трафик клиента на сервере"
                  className="max-w-full pt-1 text-[13px] font-medium hover:text-accent sm:truncate"
                >
                  {list[0]?.serverName}
                </Link>
                <ServerOnlineMark serverId={serverId} live={live} />
              </div>
              <div className="flex min-w-0 grow flex-col gap-1.5">
                <div className="flex flex-wrap gap-1.5">
                  {list.map((b) => (
                    <BindingPill
                      key={b.id}
                      b={b}
                      device={data.devices.find((d) => d.id === b.deviceId)}
                      live={live.binding(b.id)}
                      onOpen={
                        b.service === 'xui'
                          ? () => setQr(true)
                          : b.state !== 'ok'
                            ? undefined
                            : b.service === 'mtproxyl' ||
                                b.service === 'wdtt' ||
                                b.service === 'openflux' ||
                                b.service === 'naive'
                              ? () => setLinksBinding(b)
                              : () => setAwgConfigBinding(b)
                      }
                    />
                  ))}
                </div>
                {list
                  .filter((b) => b.state === 'error')
                  .map((b) => (
                    <div key={b.id} className="break-words text-xs text-bad">
                      {pillLabel(
                        b,
                        data.devices.find((d) => d.id === b.deviceId),
                      )}
                      : {b.error}
                    </div>
                  ))}
              </div>
            </div>
          ))}
        </Section>
      </div>

      <Dialog
        open={awgConfigBinding !== null}
        onClose={() => setAwgConfigBinding(null)}
        title={awgConfigBinding ? `${awgConfigBinding.serverName}: AWG` : ''}
      >
        {awgConfigBinding && (
          <ClientConfig
            serverId={awgConfigBinding.serverId}
            container={awgConfigBinding.awg?.container ?? ''}
            publicKey={awgConfigBinding.awg?.publicKey ?? ''}
            name={c.name}
            device={data.devices.find((d) => d.id === awgConfigBinding.deviceId)?.type}
          />
        )}
      </Dialog>
      <Dialog
        open={linksBinding !== null}
        onClose={() => setLinksBinding(null)}
        title={
          linksBinding
            ? `${linksBinding.serverName}: ${serviceByBinding(linksBinding.service)?.clientTitle ?? ''}`
            : ''
        }
      >
        {linksBinding && <ProxyLinks clientId={id} binding={linksBinding} exts={data.browserExt} />}
      </Dialog>
      <Dialog open={qr} onClose={() => setQr(false)} title="Подписка VLESS">
        <div className="flex flex-col items-center gap-3">
          <div className="flex items-center gap-1 self-stretch text-[13px] text-muted">
            Одна подписка на все серверы
            <InfoTip>
              Для Happ, v2rayNG, Hiddify и других. Список серверов обновляется в приложении
              автоматически.
            </InfoTip>
          </div>
          <QrCode text={data.subscription.url} alt="QR-код подписки VLESS" />
          <LinkButton
            href={`happ://add/${data.subscription.url}`}
            variant="primary"
            size="md"
            wide
            title="Добавить подписку VLESS в Happ"
            copyText={data.subscription.url}
            copyTitle="Скопировать ссылку подписки VLESS"
          >
            Добавить в Happ
          </LinkButton>
        </div>
      </Dialog>
      <ClientWatchDialog open={watchOpen} onClose={() => setWatchOpen(false)} clientId={id} />
      <Dialog open={accessOpen} onClose={() => setAccessOpen(false)} title="Доступ">
        {accessOpen && (
          <AccessForm
            access={c.access}
            bindings={data.bindings}
            devices={data.devices}
            onSave={async (access) => {
              await api(`/api/gclients/${id}`, { method: 'PATCH', json: { access } });
              await refresh();
              setAccessOpen(false);
            }}
          />
        )}
      </Dialog>
      <Dialog open={rename} onClose={() => setRename(false)} title="Имя и заметка">
        <RenameForm
          name={c.name}
          note={c.note}
          onSave={async (name, note) => {
            await api(`/api/gclients/${id}`, { method: 'PATCH', json: { name, note } });
            await refresh();
            setRename(false);
          }}
        />
      </Dialog>
      <Dialog
        open={device !== null}
        onClose={() => setDevice(null)}
        title={device === 'new' ? 'Новое устройство' : 'Устройство'}
      >
        {device !== null && (
          <DeviceForm
            device={device === 'new' ? null : device}
            onSave={async (d) => {
              if (device === 'new')
                await api(`/api/gclients/${id}/devices`, { method: 'POST', json: d });
              else
                await api(`/api/gclients/${id}/devices/${device.id}`, { method: 'PATCH', json: d });
              await refresh();
              setDevice(null);
            }}
          />
        )}
      </Dialog>
    </>
  );
}
