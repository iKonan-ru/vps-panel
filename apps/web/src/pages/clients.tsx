import { AccessEditor } from '@/components/clients/access-editor';
import { BindingStates, deviceTitle } from '@/components/clients/binding-states';
import {
  ClientsFilter,
  applyView,
  filtered,
  useClientsView,
} from '@/components/clients/clients-filter';
import { SyncPanel, useSyncState } from '@/components/clients/sync-panel';
import { DeviceSelect } from '@/components/device-select';
import { ActionBar } from '@/components/ui/action-bar';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { GClientAccess, GClientRow, GServer, XuiOwnInbound } from '@vps/protocol';
import { ListChecks, Plus, RefreshCw, Server, SlidersHorizontal } from 'lucide-react';
import { type FormEvent, useState } from 'react';

/**
 * Глобальные клиенты: человек с устройствами; VLESS и MTProxy - на человека, AWG - на устройство;
 * на всех серверах, кроме исключённых (сервер панели - только если включён).
 */
export function ClientsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, error } = useQuery({
    queryKey: ['gclients'],
    queryFn: () => api<GClientRow[]>('/api/gclients'),
    refetchInterval: 15_000,
  });
  const servers = useQuery({
    queryKey: ['gclient-servers'],
    queryFn: () => api<GServer[]>('/api/gclients/servers'),
  });
  const [view, setView] = useClientsView();
  // спрятанный фильтр не должен молча прятать клиентов: включённый открывает блок сразу
  const [filtersOpen, setFiltersOpen] = useState(() => filtered(view));
  const shown = data ? applyView(data, servers.data ?? [], view) : undefined;
  const [adding, setAdding] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  const sync = useAction();
  const syncState = useSyncState();
  const syncing = sync.busy || Boolean(syncState.data?.syncing);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Клиенты</PageTitle>
        {data && (
          <Chip>{shown && filtered(view) ? `${shown.length} из ${data.length}` : data.length}</Chip>
        )}
        <div className="grow" />
        {data && data.length > 0 && (
          <Button
            variant={filtersOpen ? 'primary' : 'default'}
            size="sm"
            aria-expanded={filtersOpen}
            aria-label="Фильтры и сортировка"
            title="Фильтры и сортировка"
            className="relative"
            onClick={() => setFiltersOpen((v) => !v)}
          >
            <SlidersHorizontal className="size-3.5" />
            <span className="hidden sm:inline">Фильтры</span>
            {!filtersOpen && filtered(view) && (
              <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-accent ring-2 ring-bg" />
            )}
          </Button>
        )}
        <ActionBar
          topbar
          actions={[
            {
              key: 'add',
              label: 'Добавить клиента',
              short: 'Добавить',
              icon: <Plus className="size-3.5" />,
              variant: 'primary',
              onClick: () => setAdding(true),
              mobile: true,
              group: 'add',
            },
            {
              key: 'servers',
              label: 'Серверы клиентов',
              icon: <Server className="size-3.5" />,
              title: 'На каких серверах и в каких inbound 3X-UI заводятся клиенты',
              onClick: () => setServersOpen(true),
            },
            {
              key: 'sync',
              label: syncing ? 'Синхронизация\u2026' : 'Синхронизировать',
              icon: <RefreshCw className={syncing ? 'size-3.5 animate-spin' : 'size-3.5'} />,
              disabled: syncing,
              title: syncing ? undefined : 'Полная синхронизация всех клиентов на всех серверах',
              onClick: () =>
                void sync.run(async () => {
                  await api('/api/gclients/sync', { method: 'POST', json: { all: true } });
                  await qc.invalidateQueries({ queryKey: ['gclients-syncing'] });
                }),
            },
          ]}
        />
      </div>
      {error && <Alert tone="bad">{error.message}</Alert>}
      {sync.error && <Alert tone="bad">{sync.error}</Alert>}
      <SyncPanel />
      {data && data.length > 0 && filtersOpen && (
        <ClientsFilter view={view} set={setView} servers={servers.data ?? []} />
      )}
      {data && data.length === 0 && (
        <Card className="p-8 text-[13px] text-muted">Клиентов пока нет</Card>
      )}
      {data && data.length > 0 && shown?.length === 0 && (
        <Card className="p-8 text-[13px] text-muted">Под фильтры не подходит ни один клиент</Card>
      )}
      {/* колонок - сколько влезает карточек от 300px: на телефоне одна, на широком экране 3-5 */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2">
        {shown?.map((c) => (
          <Link key={c.id} to="/clients/$id" params={{ id: c.id }} className="min-w-0">
            {/* плашки состояний - строкой под именем, внизу карточки: в ряду они на одной линии */}
            <Card className="flex h-full flex-col gap-2 p-3.5 hover:border-accent">
              <div className="min-w-0 flex-1">
                {/* строка имени не переносится: длинное имя обрезается, значок выборочного
                    доступа - всегда у правого края */}
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate font-semibold" title={c.name}>
                    {c.name}
                  </span>
                  {!c.enabled && (
                    <Chip tone="muted" className="shrink-0">
                      выключен
                    </Chip>
                  )}
                  {c.limited && (
                    <SlidersHorizontal
                      className="ml-auto size-3.5 shrink-0 text-accent"
                      role="img"
                      aria-label="Выборочный доступ"
                    >
                      <title>Выборочный доступ: только выбранные серверы и сервисы</title>
                    </SlidersHorizontal>
                  )}
                </div>
                <div
                  className="truncate text-xs text-muted"
                  title={c.devices.map(deviceTitle).join(', ')}
                >
                  {c.devices.length ? c.devices.map(deviceTitle).join(', ') : 'устройств нет'}
                  {c.servers.length > 0 && `; серверов ${c.servers.length}`}
                </div>
              </div>
              {c.states.ok + c.states.pending + c.states.error > 0 && (
                <BindingStates s={c.states} />
              )}
            </Card>
          </Link>
        ))}
      </div>
      <Dialog open={serversOpen} onClose={() => setServersOpen(false)} title="Серверы клиентов">
        <ServersList />
      </Dialog>
      <Dialog open={adding} onClose={() => setAdding(false)} title="Новый клиент">
        <AddClientForm
          onDone={(id) => {
            setAdding(false);
            void qc.invalidateQueries({ queryKey: ['gclients'] });
            void navigate({ to: '/clients/$id', params: { id } });
          }}
        />
      </Dialog>
    </>
  );
}

function AddClientForm({ onDone }: { onDone: (id: string) => void }) {
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [dev, setDev] = useState({ name: '', type: '', awg20: false });
  const [access, setAccess] = useState<GClientAccess>(null);
  const { data: servers } = useQuery({
    queryKey: ['gclient-servers'],
    queryFn: () => api<GServer[]>('/api/gclients/servers'),
  });
  const op = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    await op.run(async () => {
      const withDevice = dev.type || dev.name.trim();
      const r = await api<{ id: string }>('/api/gclients', {
        method: 'POST',
        json: { name: name.trim(), note, devices: withDevice ? [dev] : [], access },
      });
      onDone(r.id);
    });
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label="Имя" htmlFor="gc-name" hint="клиент его не видит">
        <Input
          id="gc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          required
          autoFocus
          placeholder="Иван"
        />
      </Field>
      <Field label="Заметка" htmlFor="gc-note">
        <Input
          id="gc-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </Field>
      <div className="text-[13px] font-medium">Первое устройство (необязательно)</div>
      <div className="flex flex-wrap gap-2">
        <DeviceSelect
          value={dev.type}
          onChange={(type) => setDev({ ...dev, type })}
          className="min-w-0 basis-full sm:basis-48"
        />
        <Input
          value={dev.name}
          onChange={(e) => setDev({ ...dev, name: e.target.value })}
          maxLength={64}
          placeholder="iPhone 15"
          aria-label="Название устройства"
          className="min-w-0 basis-full sm:basis-0 sm:grow"
        />
      </div>
      <Checkbox
        checked={dev.awg20}
        onChange={(e) => setDev({ ...dev, awg20: e.target.checked })}
        label="AWG 2.0 для старых приложений и роутеров"
      />
      <div className="text-[13px] font-medium">Доступ</div>
      <AccessEditor value={access} onChange={setAccess} servers={servers ?? []} />
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={op.busy || !name.trim()}>
          Добавить
        </Button>
      </div>
    </form>
  );
}

/** Окно "Серверы": где заводятся глобальные клиенты - участие сервера и исключённые inbound-ы 3X-UI. */
function ServersList() {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['gclient-servers'],
    queryFn: () => api<GServer[]>('/api/gclients/servers'),
  });
  // inbound-ы сервера разворачиваются под его строкой
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useAction();
  if (!data) return <div className="text-[13px] text-muted">Загрузка&hellip;</div>;
  return (
    <div className="flex flex-col">
      {toggle.error && <Alert tone="bad">{toggle.error}</Alert>}
      {data.map((s) => {
        const panelHost = s.panelHost;
        const open = openId === s.id && s.active && s.xui;
        return (
          <div key={s.id} className="border-b border-border py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Switch
                checked={s.enabled}
                disabled={toggle.busy}
                label={`Клиенты на ${s.name}`}
                onChange={() =>
                  void toggle.run(async () => {
                    // сервер панели: включение заводит на нём всех клиентов - спросить
                    if (
                      panelHost &&
                      !s.enabled &&
                      !(await ask({
                        title: `Заводить клиентов на сервере панели ${s.name}?`,
                        text: 'Клиенты будут заведены во всех установленных сервисах. Порты 80 и 443 заняты панелью, а нагрузка клиентов ляжет на её сервер.',
                        okLabel: 'Заводить',
                      }))
                    )
                      return;
                    await api(`/api/servers/${s.id}/gclients`, {
                      method: 'PATCH',
                      json: { enabled: !s.enabled },
                    });
                    await qc.invalidateQueries({ queryKey: ['gclient-servers'] });
                  })
                }
              />
              <div className="min-w-0 grow">
                <div className="text-[13px] font-medium">{s.name}</div>
                <div className="text-xs text-muted">
                  {panelHost && !s.enabled
                    ? 'сервер панели: клиенты не заводятся'
                    : !s.enabled
                      ? 'исключён: клиенты не заводятся, заведённые удаляются'
                      : !s.xui
                        ? '3X-UI нет'
                        : s.online
                          ? panelHost
                            ? 'сервер панели, участвует; порты 80 и 443 заняты панелью'
                            : 'участвует'
                          : 'участвует, не в сети'}
                </div>
              </div>
              {s.active && s.xui && (
                <Button
                  size="sm"
                  disabled={!s.online}
                  aria-expanded={Boolean(open)}
                  variant={open ? 'primary' : 'default'}
                  onClick={() => setOpenId(open ? null : s.id)}
                  label="Inbound"
                  title="В какие inbound VLESS добавлять клиентов"
                >
                  <ListChecks className="size-3.5" />
                </Button>
              )}
            </div>
            {open && (
              <div className="mt-3 rounded-lg border border-border bg-surface-2 p-3">
                <InboundsForm server={s} onDone={() => setOpenId(null)} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function InboundsForm({ server, onDone }: { server: GServer; onDone: () => void }) {
  const qc = useQueryClient();
  const { data, error } = useQuery({
    queryKey: ['xui-vless', server.id],
    queryFn: () => api<XuiOwnInbound[]>(`/api/servers/${server.id}/xui/inbounds`),
    gcTime: 0,
  });
  const [excluded, setExcluded] = useState<number[] | null>(null);
  const save = useAction();
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <div className="text-sm text-muted">Загрузка&hellip;</div>;
  const ex = excluded ?? data.filter((i) => i.excluded).map((i) => i.id);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-muted">
        Клиенты добавляются в отмеченные inbound VLESS; новые inbound отмечаются автоматически
      </div>
      {data.length === 0 && <div className="text-sm text-muted">Inbound VLESS нет</div>}
      {data.map((i) => (
        <Checkbox
          key={i.id}
          checked={!ex.includes(i.id)}
          onChange={(e) =>
            setExcluded(e.target.checked ? ex.filter((x) => x !== i.id) : [...ex, i.id])
          }
          label={i.remark || `inbound ${i.id}`}
          hint={`порт ${i.port}${i.security ? `, ${i.security}` : ''}${i.enable ? '' : ', выключен в 3X-UI: клиенты не добавляются'}`}
        />
      ))}
      {save.error && <Alert tone="bad">{save.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onDone}>Отмена</Button>
        <Button
          variant="primary"
          disabled={save.busy}
          onClick={async () => {
            const ok = await save.run(() =>
              api(`/api/servers/${server.id}/xui/excluded`, {
                method: 'PUT',
                json: { inboundIds: ex },
              }),
            );
            if (!ok) return;
            void qc.invalidateQueries({ queryKey: ['xui-inbounds', server.id] });
            onDone();
          }}
        >
          Сохранить
        </Button>
      </div>
    </div>
  );
}
