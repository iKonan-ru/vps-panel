import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Pager, usePaged } from '@/components/ui/pager';
import { Section } from '@/components/ui/section';
import { Select } from '@/components/ui/select';
import { StatusDot } from '@/components/ui/status-dot';
import { TBody, THead, Table } from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { bytes, dateFull } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { XuiClientRow, XuiInboundRow } from '@vps/protocol';
import { Cable, Pencil, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';

/** Inbound-ы, куда сверка заводит клиентов панели по умолчанию: свой VLESS, включён, не исключён. */
const isDefault = (i: XuiInboundRow) =>
  i.protocol === 'vless' && !i.node && i.enable && !i.excluded;

/** Клиенты 3X-UI и их inbound-ы; набор клиента панели держит сверка, "Как у всех" - общий. */
export function XuiClients({
  serverId,
  inbounds,
  disabled,
  reason,
}: {
  serverId: string;
  inbounds: XuiInboundRow[] | undefined;
  disabled: boolean;
  reason: string | undefined;
}) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data, error, isFetching } = useQuery({
    queryKey: ['xui-clients', serverId],
    queryFn: () => api<XuiClientRow[]>(`/api/servers/${serverId}/xui/clients`),
    staleTime: 20_000,
    retry: false,
  });
  const [q, setQ] = useState('');
  const [inb, setInb] = useState('all');
  const [edit, setEdit] = useState<XuiClientRow | null>(null);
  const op = useAction();
  const noToken = error instanceof ApiError && error.code === 'no-token';
  const byId = new Map((inbounds ?? []).map((i) => [i.id, i]));
  const needle = q.trim().toLowerCase();
  const rows = (data ?? []).filter(
    (c) =>
      (inb === 'all' || c.inboundIds.includes(Number(inb))) &&
      (!needle || `${c.email} ${c.comment} ${c.panel?.name ?? ''}`.toLowerCase().includes(needle)),
  );
  const paged = usePaged(rows, 15);
  // список перечитывается - кнопки по нему недоступны (решение по старым данным)
  const locked = disabled || op.busy || isFetching;

  async function save(c: XuiClientRow, body: { inboundIds?: number[]; reset?: boolean }) {
    await op.run(async () => {
      await api(`/api/servers/${serverId}/xui/clients/${encodeURIComponent(c.email)}/inbounds`, {
        method: 'POST',
        json: body,
      });
      await qc.invalidateQueries({ queryKey: ['xui-clients', serverId] });
      void qc.invalidateQueries({ queryKey: ['xui-inbounds', serverId] });
      setEdit(null);
    });
  }

  async function remove(c: XuiClientRow) {
    const ok = await ask({
      title: `Удалить клиента \u00ab${c.email}\u00bb?`,
      text: 'Клиент удалится из 3X-UI на этом сервере вместе со статистикой',
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await op.run(async () => {
      await api(`/api/servers/${serverId}/xui/clients/${encodeURIComponent(c.email)}`, {
        method: 'DELETE',
      });
      await qc.invalidateQueries({ queryKey: ['xui-clients', serverId] });
      void qc.invalidateQueries({ queryKey: ['xui-inbounds', serverId] });
    });
  }

  /** Кнопки строки: набор inbound-ов и удаление (клиенты панели и служебные - не здесь). */
  const RowButtons = ({ c }: { c: XuiClientRow }) => (
    <div className="flex shrink-0 justify-end">
      <Button
        size="icon-sm"
        variant="ghost"
        title={c.service ? serviceTitle(c.service) : (reason ?? 'Inbound клиента')}
        aria-label="Inbound клиента"
        disabled={locked || !inbounds || Boolean(c.service)}
        onClick={() => {
          op.setError(null);
          setEdit(c);
        }}
      >
        <Pencil className="size-3.5" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        title={
          c.service
            ? serviceTitle(c.service)
            : c.panel
              ? 'Клиент панели удаляется в своей карточке'
              : (reason ?? 'Удалить клиента')
        }
        aria-label="Удалить клиента"
        disabled={locked || Boolean(c.panel) || Boolean(c.service)}
        onClick={() => void remove(c)}
      >
        <Trash2 className={cn('size-3.5', !c.panel && !c.service && 'text-bad')} />
      </Button>
    </div>
  );

  return (
    <Section
      title="Клиенты"
      info={
        'Свой набор inbound клиента панели сохраняется при синхронизации, новые inbound он не получает. \u00abКак у всех\u00bb возвращает общий набор.'
      }
      extra={data && <Chip>{data.length}</Chip>}
    >
      {op.error && !edit && (
        <div className="p-4 pb-0">
          <Alert tone="bad">{op.error}</Alert>
        </div>
      )}
      {error && (
        <div className="px-4 py-3 text-[13px] text-muted">
          {noToken ? 'Нужен API-токен 3X-UI' : `Не удалось получить клиентов: ${error.message}`}
        </div>
      )}
      {!data && !error && (
        <div className="px-4 py-3 text-[13px] text-muted">
          {isFetching ? 'Загрузка\u2026' : 'Нет данных'}
        </div>
      )}
      {data && data.length > 0 && (
        // на телефоне фильтр и поиск - каждый во всю ширину: иначе их раскладка зависела бы от
        // длины подписей inbound-ов и на разных серверах была бы разной
        <div className="flex flex-col gap-2 px-4 py-2 sm:flex-row sm:items-center">
          <Select
            size="sm"
            aria-label="Inbound"
            className="w-full sm:w-auto sm:max-w-[240px]"
            value={inb}
            onChange={(e) => setInb(e.target.value)}
          >
            <option value="all">все inbound</option>
            {(inbounds ?? []).map((i) => (
              <option key={i.id} value={i.id}>
                {i.remark || `#${i.id}`}
              </option>
            ))}
          </Select>
          <Input
            type="search"
            aria-label="Поиск"
            placeholder="Email, комментарий, клиент панели"
            className="h-7 w-full text-xs sm:w-[240px]"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
      )}
      {data && rows.length === 0 && (
        <div className="px-4 py-3 text-[13px] text-muted">
          {data.length ? 'Ничего не найдено' : 'Клиентов нет'}
        </div>
      )}
      {paged.items.length > 0 && (
        <>
          <div className="hidden md:block">
            <Table>
              <THead>
                <tr>
                  <th>Клиент</th>
                  <th>Inbound</th>
                  <th className="text-right">Трафик</th>
                  <th className="w-0" />
                </tr>
              </THead>
              <TBody className="[&>tr>td]:py-1">
                {paged.items.map((c) => (
                  <tr key={c.email} className={cn(!c.enable && 'opacity-60')}>
                    <td className="max-w-[320px]">
                      <div className="flex min-w-0 items-center gap-2">
                        <StatusDot enabled={c.enable} online={c.online} />
                        <span className="shrink-0 font-mono">{c.email}</span>
                        <Who c={c} />
                      </div>
                    </td>
                    <td className="max-w-[240px] whitespace-nowrap text-xs">
                      <InboundNames ids={c.inboundIds} byId={byId} />
                    </td>
                    <td
                      className="whitespace-nowrap text-right text-xs text-muted"
                      title={limits(c)}
                    >
                      {traffic(c)}
                    </td>
                    <td className="whitespace-nowrap">
                      <RowButtons c={c} />
                    </td>
                  </tr>
                ))}
              </TBody>
            </Table>
          </div>
          {/* узкий экран: две строки на клиента всегда, у всех одинаково - email и кнопки, под
              ним клиент панели (или служебный, комментарий), inbound-ы и трафик */}
          <div className="md:hidden">
            {paged.items.map((c) => (
              <div
                key={c.email}
                className={cn(
                  'flex items-start gap-2 border-t border-border px-4 py-1.5',
                  !c.enable && 'opacity-60',
                )}
              >
                <StatusDot enabled={c.enable} online={c.online} className="mt-[7px]" />
                <div className="min-w-0 grow">
                  <div className="flex h-7 items-center gap-2">
                    <span className="min-w-0 truncate font-mono text-[13px]">{c.email}</span>
                    <span
                      className="ml-auto shrink-0 text-xs tabular-nums text-muted"
                      title={limits(c)}
                    >
                      {traffic(c)}
                    </span>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 text-xs">
                    <Who c={c} />
                    <span className="min-w-0 grow">
                      <InboundNames ids={c.inboundIds} byId={byId} />
                    </span>
                  </div>
                </div>
                <RowButtons c={c} />
              </div>
            ))}
          </div>
        </>
      )}
      <Pager {...paged} />
      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit ? `Inbound: ${edit.email}` : ''}
      >
        {edit && inbounds && (
          <InboundsForm
            key={edit.email}
            client={edit}
            inbounds={inbounds}
            busy={op.busy}
            error={op.error}
            onCancel={() => setEdit(null)}
            onSave={(ids) => void save(edit, { inboundIds: ids })}
            onReset={() => void save(edit, { reset: true })}
          />
        )}
      </Dialog>
    </Section>
  );
}

/** Inbound-ы клиента одной строкой: не влезло - многоточие, весь список - в подсказке. */
function InboundNames({ ids, byId }: { ids: number[]; byId: Map<number, XuiInboundRow> }) {
  if (ids.length === 0) return <span className="text-warn">нет inbound</span>;
  const all = ids.map((id) => byId.get(id)?.remark || `#${id}`).join(', ');
  return (
    <span className="block truncate text-muted" title={all}>
      {all}
    </span>
  );
}

const traffic = (c: XuiClientRow) =>
  `${bytes(c.up + c.down)}${c.totalGB ? ` / ${bytes(c.totalGB)}` : ''}`;

const limits = (c: XuiClientRow) =>
  [
    c.totalGB ? `лимит: ${bytes(c.totalGB)}` : '',
    c.expiryTime > 0 ? `до ${dateFull(c.expiryTime)}` : '',
  ]
    .filter(Boolean)
    .join(', ') || undefined;

function serviceTitle(s: NonNullable<XuiClientRow['service']>): string {
  return s.kind === 'telegram'
    ? 'Выход панели в Telegram: его ведёт панель'
    : `Служебный клиент каскада${s.entry ? ` с ${s.entry.name}` : ''}: его ведёт панель`;
}

/**
 * Кто это: клиент панели (значок и имя - ссылка на карточку), служебный клиент панели или
 * комментарий 3X-UI. На узком экране - значком и коротким именем, длинное обрезается.
 */
function Who({ c }: { c: XuiClientRow }) {
  if (c.panel)
    return (
      <Link
        to="/clients/$id"
        params={{ id: c.panel.clientId }}
        title={`Клиент панели ${c.panel.name}${c.panel.custom ? ', свой набор inbound' : ''}`}
        className="inline-flex min-w-0 max-w-[60%] shrink-0 items-center gap-1 text-xs text-accent hover:underline md:max-w-none md:shrink"
      >
        <UserRound className="size-3.5 shrink-0" />
        <span className="truncate">{c.panel.name}</span>
        {c.panel.custom && <span className="shrink-0">*</span>}
      </Link>
    );
  if (c.service)
    return (
      <span
        className="inline-flex min-w-0 shrink-0 items-center gap-1 text-xs text-accent"
        title={serviceTitle(c.service)}
      >
        <Cable className="size-3.5 shrink-0" />
        {c.service.kind === 'telegram' ? (
          <span className="truncate">выход в Telegram</span>
        ) : c.service.entry ? (
          <Link
            to="/servers/$id/$tab"
            params={{ id: c.service.entry.id, tab: 'xui' }}
            className="truncate hover:underline"
          >
            каскад с {c.service.entry.name}
          </Link>
        ) : (
          <span className="truncate">каскад</span>
        )}
      </span>
    );
  if (!c.comment) return null;
  return (
    <span
      className="min-w-0 max-w-[60%] shrink-0 truncate text-xs text-muted md:max-w-none md:shrink"
      title={c.comment}
    >
      {c.comment}
    </span>
  );
}

function InboundsForm({
  client,
  inbounds,
  busy,
  error,
  onCancel,
  onSave,
  onReset,
}: {
  client: XuiClientRow;
  inbounds: XuiInboundRow[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (ids: number[]) => void;
  onReset: () => void;
}) {
  // клиенту панели - только свои VLESS-inbound-ы (так считает и сверка); inbound-ы узлов - на узлах
  const choices = inbounds.filter((i) => !i.node && (!client.panel || i.protocol === 'vless'));
  const [sel, setSel] = useState(() => new Set(client.inboundIds));
  const ids = [...sel].filter((id) => choices.some((i) => i.id === id));
  const changed =
    ids.length !== client.inboundIds.length || ids.some((id) => !client.inboundIds.includes(id));
  const defaults = inbounds.filter(isDefault).map((i) => i.id);
  return (
    <div className="flex flex-col gap-3">
      <div className="text-[13px] text-muted">
        {client.panel
          ? client.panel.custom
            ? 'Свой набор: сохраняется при синхронизации, новые inbound клиент не получает'
            : 'Общий набор. Другой набор запомнится и будет сохраняться при синхронизации.'
          : 'Клиент не из панели: привязка меняется прямо в 3X-UI'}
      </div>
      <div className="flex flex-col gap-2">
        {choices.map((i) => (
          <Checkbox
            key={i.id}
            checked={sel.has(i.id)}
            onChange={() => {
              const next = new Set(sel);
              if (next.has(i.id)) next.delete(i.id);
              else next.add(i.id);
              setSel(next);
            }}
            label={
              <span className="flex flex-wrap items-center gap-2">
                {i.remark || `#${i.id}`}
                <span className="font-mono text-xs text-muted">
                  {i.port} {[i.protocol, i.network].filter(Boolean).join('/')}
                </span>
                {!i.enable && <Chip tone="muted">выключен</Chip>}
                {client.panel && defaults.includes(i.id) && <Chip>общий набор</Chip>}
              </span>
            }
          />
        ))}
        {choices.length === 0 && (
          <span className="text-[13px] text-muted">Подходящих inbound нет</span>
        )}
      </div>
      {ids.length === 0 && (
        <Alert tone="info">
          Нужен хотя бы один inbound.
          {client.panel && ' Убрать клиента панели с сервера можно в его карточке.'}
        </Alert>
      )}
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        {client.panel?.custom && (
          <Button
            disabled={busy}
            onClick={onReset}
            title="Общий набор: свои VLESS, кроме исключённых"
          >
            Как у всех
          </Button>
        )}
        <div className="grow" />
        <Button onClick={onCancel}>Отмена</Button>
        <Button
          variant="primary"
          disabled={busy || !changed || ids.length === 0}
          onClick={() => onSave(ids)}
        >
          Сохранить
        </Button>
      </div>
    </div>
  );
}
