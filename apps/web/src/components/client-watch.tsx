import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { dateTime, hm } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  type GService,
  WATCH_DELAY_DEFAULT,
  WATCH_DELAY_LIMITS,
  WATCH_EVENTS,
  WATCH_SERVICES,
  type WatchClientOption,
  type WatchList,
  type WatchRuleBody,
  type WatchRuleView,
  serviceByBinding,
} from '@vps/protocol';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';

const NB = '\u00a0';
const serviceTitle = (s: GService) => serviceByBinding(s)?.clientTitle ?? s;

/** Правила уведомлений о подключении; пока открыт список - раз в 20 с. */
export function useWatch() {
  return useQuery({
    queryKey: ['watch'],
    queryFn: () => api<WatchList>('/api/watch'),
    refetchInterval: 20_000,
  });
}

/** За чем следит правило: "AWG, Hoster", "все сервисы и серверы". */
function scope(r: WatchRuleView): string {
  const server = r.serverId ? r.serverName || 'сервер удалён' : null;
  const service = r.service ? serviceTitle(r.service) : null;
  if (service && server) return `${service}, ${server}`;
  if (service) return `${service}, все серверы`;
  if (server) return `все сервисы, ${server}`;
  return 'все сервисы и серверы';
}

/** Когда: сегодня - 09:05, раньше - 22.10 09:05. */
const when = (iso: string) =>
  new Date(iso).toDateString() === new Date().toDateString() ? hm(iso) : dateTime(iso);

function StatusChip({ r }: { r: WatchRuleView }) {
  const since = r.lastSeen ?? r.downSince;
  switch (r.status) {
    case 'up':
      return (
        <Chip tone="ok" dot>
          на связи
        </Chip>
      );
    case 'down':
      return (
        <Chip
          tone={r.offline ? 'bad' : 'warn'}
          dot
          title={since ? `последняя активность ${dateTime(since)}` : undefined}
        >
          {r.offline ? 'нет связи' : 'не на связи'}
          {since && ` с ${when(since)}`}
        </Chip>
      );
    case 'unknown':
      return (
        <Chip title={r.note || undefined}>{r.note ? `неизвестно: ${r.note}` : 'неизвестно'}</Chip>
      );
    case 'pending':
      return <Chip>проверка&hellip;</Chip>;
    default:
      return <Chip>выключено</Chip>;
  }
}

const bodyOf = (r: WatchRuleView): WatchRuleBody => ({
  clientId: r.clientId,
  serverId: r.serverId,
  service: r.service,
  deviceId: r.deviceId,
  event: r.event,
  delayMinutes: r.delayMinutes,
  enabled: r.enabled,
});

/** Список правил: все или одного клиента (тогда без имени клиента). */
function WatchRules({
  rules,
  clients,
  clientId,
}: { rules: WatchRuleView[]; clients: WatchClientOption[]; clientId?: string }) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const op = useAction();
  const [edit, setEdit] = useState<WatchRuleView | null>(null);
  const list = clientId ? rules.filter((r) => r.clientId === clientId) : rules;
  const reload = () => qc.invalidateQueries({ queryKey: ['watch'] });

  async function toggle(r: WatchRuleView) {
    await op.run(async () => {
      await api(`/api/watch/${r.id}`, {
        method: 'PUT',
        json: { ...bodyOf(r), enabled: !r.enabled },
      });
      await reload();
    });
  }

  async function remove(r: WatchRuleView) {
    const ok = await ask({
      title: 'Удалить уведомление?',
      text: `${r.clientName}${r.deviceName ? `, ${r.deviceName}` : ''}: ${scope(r)}`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await op.run(async () => {
      await api(`/api/watch/${r.id}`, { method: 'DELETE' });
      await reload();
    });
  }

  return (
    <>
      {op.error && (
        <div className="px-4 pt-3">
          <Alert tone="bad">{op.error}</Alert>
        </div>
      )}
      {list.length === 0 ? (
        <div className="px-4 py-3 text-[13px] text-muted">Уведомлений нет</div>
      ) : (
        list.map((r, i) => {
          const event = WATCH_EVENTS.find((e) => e.id === r.event)?.title ?? r.event;
          return (
            <div
              key={r.id}
              style={{ '--i': i } as React.CSSProperties}
              className="stagger flex animate-rise flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-2.5 last:border-b-0"
            >
              <div className="flex min-w-0 grow basis-60 flex-col gap-0.5">
                <div className={cn('truncate text-[13px]', !r.enabled && 'text-muted')}>
                  {clientId ? (
                    scope(r)
                  ) : (
                    <>
                      <Link
                        to="/clients/$id"
                        params={{ id: r.clientId }}
                        className="font-medium hover:text-accent"
                      >
                        {r.clientName}
                      </Link>
                      {r.deviceName !== null && `, ${r.deviceName || 'устройство удалено'}`}
                    </>
                  )}
                </div>
                <div className="truncate text-xs text-muted">
                  {clientId
                    ? r.deviceName !== null && `${r.deviceName || 'устройство удалено'}, `
                    : `${scope(r)}\u00a0\u2014 `}
                  {event.toLocaleLowerCase('ru')}, {r.delayMinutes}
                  {NB}мин
                </div>
              </div>
              <StatusChip r={r} />
              <div className="flex items-center gap-1">
                <Switch
                  label={`${r.clientName}: ${scope(r)}`}
                  checked={r.enabled}
                  disabled={op.busy}
                  onChange={() => void toggle(r)}
                />
                <Button size="icon-sm" variant="ghost" title="Изменить" onClick={() => setEdit(r)}>
                  <Pencil className="size-3.5" />
                </Button>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  title="Удалить"
                  disabled={op.busy}
                  onClick={() => void remove(r)}
                >
                  <Trash2 className="size-3.5 text-bad" />
                </Button>
              </div>
            </div>
          );
        })
      )}
      <WatchRuleDialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        rule={edit}
        clients={clients}
        lockClient={Boolean(clientId)}
      />
    </>
  );
}

/** Окно правила: клиент, сервер, сервис, устройство, событие, задержка. */
function WatchRuleDialog({
  open,
  onClose,
  rule,
  clientId,
  clients,
  lockClient,
}: {
  open: boolean;
  onClose: () => void;
  /** правка; null - новое */
  rule: WatchRuleView | null;
  /** клиент нового правила */
  clientId?: string;
  clients: WatchClientOption[];
  lockClient?: boolean;
}) {
  const qc = useQueryClient();
  const op = useAction();
  const { setError } = op;
  const id = useId();
  const [v, setV] = useState<WatchRuleBody>(() => blank(clientId));
  const [delay, setDelay] = useState(String(WATCH_DELAY_DEFAULT));

  // при каждом открытии - с правила или пустое; список перечитывается раз в 20 с, форму это не
  // сбрасывает: правило и клиенты - из ref на момент открытия
  const src = useRef({ rule, clientId, clients });
  src.current = { rule, clientId, clients };
  useEffect(() => {
    if (!open) return;
    const { rule: r, clientId: cid, clients: cs } = src.current;
    const b = r ? bodyOf(r) : blank(cid ?? cs[0]?.id);
    setV(b);
    setDelay(String(b.delayMinutes));
    setError(null);
  }, [open, setError]);

  const client = clients.find((c) => c.id === v.clientId);
  const targets = client?.targets ?? [];
  const serverOpts = [...new Map(targets.map((t) => [t.serverId, t.serverName])).entries()];
  const onServer = targets.filter((t) => !v.serverId || t.serverId === v.serverId);
  const serviceOpts = WATCH_SERVICES.filter((s) => onServer.some((t) => t.service === s));
  const forDevice = onServer.filter((t) => !v.service || t.service === v.service);
  const deviceOpts = (client?.devices ?? []).filter((d) =>
    forDevice.some((t) => t.deviceId === d.id),
  );
  // правило изменённого сервера может ссылаться на то, чего уже нет: оставляем как есть
  if (v.serverId && !serverOpts.some(([sid]) => sid === v.serverId))
    serverOpts.push([v.serverId, rule?.serverName || 'сервер удалён']);
  if (v.service && !serviceOpts.includes(v.service)) serviceOpts.push(v.service);
  const deviceShown = deviceOpts.length > 0 || v.deviceId !== null;
  if (v.deviceId && !deviceOpts.some((d) => d.id === v.deviceId))
    deviceOpts.push({ id: v.deviceId, name: rule?.deviceName || 'устройство удалено' });

  const n = Number(delay);
  const delayOk =
    delay.trim() !== '' &&
    Number.isInteger(n) &&
    n >= WATCH_DELAY_LIMITS[0] &&
    n <= WATCH_DELAY_LIMITS[1];
  const ready = Boolean(client) && targets.length > 0 && delayOk;

  /** Сервер сменился: сервис и устройство, которых на нём нет, - "любой". */
  function pick(patch: Partial<WatchRuleBody>) {
    const next = { ...v, ...patch };
    const ts = (clients.find((c) => c.id === next.clientId)?.targets ?? []).filter(
      (t) => !next.serverId || t.serverId === next.serverId,
    );
    if (next.service && !ts.some((t) => t.service === next.service)) next.service = null;
    const td = ts.filter((t) => !next.service || t.service === next.service);
    if (next.deviceId && !td.some((t) => t.deviceId === next.deviceId)) next.deviceId = null;
    setV(next);
  }

  async function save() {
    await op.run(async () => {
      const json = { ...v, delayMinutes: n };
      if (rule) await api(`/api/watch/${rule.id}`, { method: 'PUT', json });
      else await api('/api/watch', { method: 'POST', json });
      await qc.invalidateQueries({ queryKey: ['watch'] });
      onClose();
    });
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={rule ? 'Уведомление о подключении' : 'Новое уведомление о подключении'}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Клиент" htmlFor={`${id}-c`} className="sm:col-span-2">
          <Select
            id={`${id}-c`}
            value={v.clientId}
            disabled={lockClient || Boolean(rule)}
            onChange={(e) =>
              setV({ ...blank(e.target.value), event: v.event, delayMinutes: v.delayMinutes })
            }
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Сервер" htmlFor={`${id}-s`}>
          <Select
            id={`${id}-s`}
            value={v.serverId ?? ''}
            onChange={(e) => pick({ serverId: e.target.value || null })}
          >
            <option value="">Любой</option>
            {serverOpts.map(([sid, name]) => (
              <option key={sid} value={sid}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Сервис" htmlFor={`${id}-v`}>
          <Select
            id={`${id}-v`}
            value={v.service ?? ''}
            onChange={(e) => pick({ service: (e.target.value || null) as GService | null })}
          >
            <option value="">Любой</option>
            {serviceOpts.map((s) => (
              <option key={s} value={s}>
                {serviceTitle(s)}
              </option>
            ))}
          </Select>
        </Field>
        {deviceShown && (
          <Field label="Устройство" htmlFor={`${id}-d`} className="sm:col-span-2">
            <Select
              id={`${id}-d`}
              value={v.deviceId ?? ''}
              onChange={(e) => pick({ deviceId: e.target.value || null })}
            >
              <option value="">Любое</option>
              {deviceOpts.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Событие" htmlFor={`${id}-e`}>
          <Select
            id={`${id}-e`}
            value={v.event}
            onChange={(e) => setV({ ...v, event: e.target.value as WatchRuleBody['event'] })}
          >
            {WATCH_EVENTS.map((e) => (
              <option key={e.id} value={e.id}>
                {e.title}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="Без связи, мин"
          htmlFor={`${id}-t`}
          hint={
            <>
              Через сколько минут без связи клиент считается отключённым. AWG замечает отключение не
              раньше чем через 3{NB}мин
            </>
          }
        >
          <Input
            id={`${id}-t`}
            type="number"
            inputMode="numeric"
            min={WATCH_DELAY_LIMITS[0]}
            max={WATCH_DELAY_LIMITS[1]}
            value={delay}
            onChange={(e) => setDelay(e.target.value)}
          />
        </Field>
      </div>
      {client && targets.length === 0 && (
        <Alert tone="info">У клиента нет подключений, за которыми можно следить</Alert>
      )}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={op.busy}>
          Отмена
        </Button>
        <Button variant="primary" onClick={save} disabled={op.busy || !ready}>
          {rule ? 'Сохранить' : 'Добавить'}
        </Button>
      </div>
    </Dialog>
  );
}

function blank(clientId = ''): WatchRuleBody {
  return {
    clientId,
    serverId: null,
    service: null,
    deviceId: null,
    event: 'both',
    delayMinutes: WATCH_DELAY_DEFAULT,
    enabled: true,
  };
}

/** Telegram не настроен: сообщения не уйдут. */
function useTgReady() {
  const { data } = useQuery({
    queryKey: ['tg-health'],
    queryFn: () => api<{ configured: boolean }>('/api/notify/telegram/health'),
  });
  return data?.configured ?? true;
}

/** Раздел "Настроек": все уведомления о подключении клиентов. */
export function ClientWatchSettings() {
  const { data } = useWatch();
  const [adding, setAdding] = useState(false);
  const tg = useTgReady();
  return (
    <Section
      title="Подключения клиентов"
      info="Сообщение в Telegram, когда клиент пропадает со связи или снова появляется. Проверка раз в минуту"
      actions={
        <Button size="sm" onClick={() => setAdding(true)} label="Добавить" disabled={!data}>
          <Plus className="size-3.5" />
        </Button>
      }
    >
      {!tg && (
        <div className="px-4 pt-3">
          <Alert tone="info">Telegram не настроен: сообщения не уйдут</Alert>
        </div>
      )}
      {data === undefined ? (
        <div className="px-4 py-3 text-[13px] text-muted">Загрузка&hellip;</div>
      ) : (
        <WatchRules rules={data.rules} clients={data.clients} />
      )}
      <WatchRuleDialog
        open={adding}
        onClose={() => setAdding(false)}
        rule={null}
        clients={data?.clients ?? []}
      />
    </Section>
  );
}

/** Число правил клиента: для кнопки в карточке клиента. */
export function useClientWatchCount(clientId: string): number {
  const { data } = useWatch();
  return data?.rules.filter((r) => r.clientId === clientId).length ?? 0;
}

/** Окно карточки клиента: его уведомления о подключении и добавление нового. */
export function ClientWatchDialog({
  open,
  onClose,
  clientId,
}: { open: boolean; onClose: () => void; clientId: string }) {
  const { data } = useWatch();
  const [adding, setAdding] = useState(false);
  const tg = useTgReady();
  return (
    <Dialog open={open} onClose={onClose} title="Уведомления о подключении" wide>
      {!tg && <Alert tone="info">Telegram не настроен: сообщения не уйдут</Alert>}
      {data === undefined ? (
        <div className="text-[13px] text-muted">Загрузка&hellip;</div>
      ) : (
        <div className="-mx-5 border-y border-border">
          <WatchRules rules={data.rules} clients={data.clients} clientId={clientId} />
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={() => setAdding(true)} disabled={!data}>
          <Plus className="size-4" />
          Добавить
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Закрыть
        </Button>
      </div>
      <WatchRuleDialog
        open={adding}
        onClose={() => setAdding(false)}
        rule={null}
        clientId={clientId}
        clients={data?.clients ?? []}
        lockClient
      />
    </Dialog>
  );
}
