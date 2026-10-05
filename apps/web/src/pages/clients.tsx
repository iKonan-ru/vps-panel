import { AccessEditor } from '@/components/clients/access-editor';
import { BindingStates, deviceTitle } from '@/components/clients/binding-states';
import { SyncPanel, useSyncState } from '@/components/clients/sync-panel';
import { DeviceSelect } from '@/components/device-select';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { PageTitle } from '@/components/ui/page-title';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import type { GClientAccess, GClientRow, GServer } from '@vps/protocol';
import { ListChecks, Plus, RefreshCw, Server } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface XuiInbound {
  id: number;
  remark: string;
  port: number;
  enable: boolean;
  security: string;
  excluded: boolean;
}

/**
 * Глобальные клиенты: человек с устройствами, VLESS и MTProxy на человека,
 * AWG на устройство, на всех серверах, кроме сервера панели и исключённых.
 */
export function ClientsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data, error } = useQuery({
    queryKey: ['gclients'],
    queryFn: () => api<GClientRow[]>('/api/gclients'),
    refetchInterval: 15_000,
  });
  const [adding, setAdding] = useState(false);
  const [serversOpen, setServersOpen] = useState(false);
  // полная сверка всех клиентов: кнопка крутится, пока сверка идёт (опрос раз в 2 с)
  const sync = useAction();
  const [syncAsked, setSyncAsked] = useState(false);
  const syncState = useSyncState();
  const syncing = sync.busy || syncAsked || Boolean(syncState.data?.syncing);

  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <PageTitle>Клиенты</PageTitle>
        {data && <Chip>{data.length}</Chip>}
        <div className="grow" />
        <Button
          size="sm"
          onClick={() => setServersOpen(true)}
          label="Серверы"
          title="На каких серверах заводятся глобальные клиенты и в какие inbound-ы 3X-UI"
        >
          <Server className="size-3.5" />
        </Button>
        <Button
          size="sm"
          disabled={syncing}
          onClick={() =>
            void sync.run(async () => {
              setSyncAsked(true);
              try {
                await api('/api/gclients/sync', { method: 'POST', json: { all: true } });
                // ждём конца сверки: кнопка освобождается, когда сервер скажет "не идёт"
                for (let i = 0; i < 300; i++) {
                  await new Promise((r) => setTimeout(r, 2_000));
                  const st = await api<{ syncing: boolean }>('/api/gclients/syncing');
                  if (!st.syncing) break;
                }
              } finally {
                setSyncAsked(false);
                await qc.invalidateQueries({ queryKey: ['gclients'] });
                void qc.invalidateQueries({ queryKey: ['gclients-syncing'] });
              }
            })
          }
          label="Сверить всех"
          title={
            syncing
              ? 'Сверка с серверами идёт: кнопка освободится, когда она закончится'
              : 'Полная сверка всех клиентов на всех серверах: каждая запись каждого сервиса приводится к панели'
          }
        >
          <RefreshCw className={syncing ? 'size-3.5 animate-spin' : 'size-3.5'} />
        </Button>
        <Button size="sm" variant="primary" onClick={() => setAdding(true)} label="Добавить">
          <Plus className="size-3.5" />
        </Button>
      </div>
      {error && <Alert tone="bad">{error.message}</Alert>}
      {sync.error && <Alert tone="bad">{sync.error}</Alert>}
      <SyncPanel />
      {data && data.length === 0 && (
        <Card className="p-8 text-[13px] text-muted">
          Клиентов пока нет. Клиент - это человек: ему на серверах заводятся VLESS (одна подписка),
          MTProxy, WDTT и AWG на каждое его устройство - везде или только на выбранных серверах и
          сервисах (доступ клиента).
        </Card>
      )}
      {/* колонок - сколько влезает карточек от 300px: на телефоне одна, на широком экране 3-5 */}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(300px,100%),1fr))] gap-2">
        {data?.map((c) => (
          <Link key={c.id} to="/clients/$id" params={{ id: c.id }} className="min-w-0">
            {/* плашки состояний - строкой под именем, внизу карточки: в ряду они на одной линии */}
            <Card className="flex h-full flex-col gap-2 p-3.5 hover:border-accent">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-semibold">{c.name}</span>
                  {!c.enabled && <Chip tone="muted">выключен</Chip>}
                  {c.limited && <Chip tone="accent">выборочный доступ</Chip>}
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
      <Dialog open={serversOpen} onClose={() => setServersOpen(false)} title="Серверы">
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
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const withDevice = dev.type || dev.name.trim();
      const r = await api<{ id: string }>('/api/gclients', {
        method: 'POST',
        json: { name: name.trim(), note, devices: withDevice ? [dev] : [], access },
      });
      onDone(r.id);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label="Имя" htmlFor="gc-name" hint="видно только в панели; клиенту - нет">
        <Input
          id="gc-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={64}
          required
          autoFocus
          placeholder="например, Иван"
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
      <div className="text-[13px] font-medium">Первое устройство (можно добавить позже)</div>
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
          placeholder="название, например iPhone 15"
          aria-label="Название устройства"
          className="min-w-0 basis-full sm:basis-0 sm:grow"
        />
      </div>
      <Checkbox
        checked={dev.awg20}
        onChange={(e) => setDev({ ...dev, awg20: e.target.checked })}
        label="Ещё AWG 2.0 (старые приложения, роутеры)"
      />
      <div className="text-[13px] font-medium">Доступ</div>
      <AccessEditor value={access} onChange={setAccess} servers={servers ?? []} />
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={busy || !name.trim()}>
          Добавить
        </Button>
      </div>
    </form>
  );
}

/** Где заводятся глобальные клиенты: участие сервера и исключённые inbound-ы 3X-UI. */
/** Серверы и их участие в глобальных клиентах (окно "Серверы"): переключатель и inbound-ы 3X-UI. */
function ServersList() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['gclient-servers'],
    queryFn: () => api<GServer[]>('/api/gclients/servers'),
  });
  // inbound-ы сервера разворачиваются под его строкой
  const [openId, setOpenId] = useState<string | null>(null);
  const toggle = useAction();
  if (!data) return <div className="text-[13px] text-muted">Загружаю...</div>;
  return (
    <div className="flex flex-col">
      <div className="pb-2 text-[13px] text-muted">
        Где заводятся глобальные клиенты. Выключенный сервер исключается: заведённое на нём
        удаляется; сервер панели исключён всегда.
      </div>
      {toggle.error && <Alert tone="bad">{toggle.error}</Alert>}
      {data.map((s) => {
        const panelHost = s.panelHost;
        const open = openId === s.id && s.active && s.xui;
        return (
          <div key={s.id} className="border-b border-border py-3 last:border-b-0">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <Switch
                checked={s.enabled && !panelHost}
                disabled={panelHost || toggle.busy}
                label={`Глобальные клиенты на ${s.name}`}
                onChange={() =>
                  void toggle.run(async () => {
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
                  {panelHost
                    ? 'сервер панели: глобальные клиенты не заводятся'
                    : !s.enabled
                      ? 'исключён: клиенты здесь не заводятся, заведённые удаляются'
                      : !s.xui
                        ? '3X-UI нет'
                        : s.online
                          ? 'участвует'
                          : 'участвует, сейчас не в сети'}
                </div>
              </div>
              {s.active && s.xui && (
                <Button
                  size="sm"
                  disabled={!s.online}
                  aria-expanded={Boolean(open)}
                  variant={open ? 'primary' : 'default'}
                  onClick={() => setOpenId(open ? null : s.id)}
                  label="Inbound-ы"
                  title="В какие VLESS-inbound-ы добавлять глобальных клиентов"
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
  const { data, error } = useQuery({
    queryKey: ['xui-inbounds', server.id],
    queryFn: () => api<XuiInbound[]>(`/api/servers/${server.id}/xui/inbounds`),
    gcTime: 0,
  });
  const [excluded, setExcluded] = useState<number[] | null>(null);
  const save = useAction();
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data) return <div className="text-sm text-muted">Спрашиваю 3X-UI...</div>;
  const ex = excluded ?? data.filter((i) => i.excluded).map((i) => i.id);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-muted">
        Глобальные клиенты добавляются в отмеченные VLESS-inbound-ы. Новые inbound-ы отмечены сразу;
        с тестовых и служебных галочку сними.
      </div>
      {data.length === 0 && <div className="text-sm text-muted">VLESS-inbound-ов нет.</div>}
      {data.map((i) => (
        <Checkbox
          key={i.id}
          checked={!ex.includes(i.id)}
          onChange={(e) =>
            setExcluded(e.target.checked ? ex.filter((x) => x !== i.id) : [...ex, i.id])
          }
          label={i.remark || `inbound ${i.id}`}
          hint={`порт ${i.port}${i.security ? `, ${i.security}` : ''}${i.enable ? '' : ', выключен в 3X-UI: клиенты в него не добавляются'}`}
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
            if (ok) onDone();
          }}
        >
          Сохранить
        </Button>
      </div>
    </div>
  );
}
