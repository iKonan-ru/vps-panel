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
import { TBody, THead, Table } from '@/components/ui/table';
import { ApiError, api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { bytes, dateFull } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import type { XuiClientRow, XuiInboundRow } from '@vps/protocol';
import { Pencil, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';

/** Inbound-ы, куда сверка заводит клиентов панели по умолчанию: свой VLESS, включён, не исключён. */
const isDefault = (i: XuiInboundRow) =>
  i.protocol === 'vless' && !i.node && i.enable && !i.excluded;

/**
 * Блок "Клиенты" вкладки 3X-UI: клиенты и их inbound-ы, правка привязки к inbound-ам. У клиента
 * панели набор запоминается в панели (сверка держит его), "Как у всех" - снова общий набор.
 */
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
        <div className="flex flex-wrap items-center gap-2 px-4 py-2">
          <Select
            size="sm"
            aria-label="Inbound"
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
            className="h-7 w-[240px] grow text-xs sm:grow-0"
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
                    <span
                      aria-label={c.online ? 'онлайн' : 'не онлайн'}
                      title={c.online ? 'онлайн' : 'не онлайн'}
                      className={cn(
                        'size-2 shrink-0 rounded-full',
                        c.online ? 'bg-ok' : 'bg-muted',
                      )}
                    />
                    <span className="shrink-0 font-mono" title={c.enable ? undefined : 'выключен'}>
                      {c.email}
                    </span>
                    {c.panel ? (
                      <Link
                        to="/clients/$id"
                        params={{ id: c.panel.clientId }}
                        title={`Клиент панели${c.panel.custom ? ', свой набор inbound' : ''}`}
                        className="inline-flex min-w-0 items-center gap-1 text-xs text-accent hover:underline"
                      >
                        <UserRound className="size-3.5 shrink-0" />
                        <span className="truncate">{c.panel.name}</span>
                        {c.panel.custom && <span className="shrink-0">*</span>}
                      </Link>
                    ) : (
                      c.comment && (
                        <span className="truncate text-xs text-muted" title={c.comment}>
                          {c.comment}
                        </span>
                      )
                    )}
                  </div>
                </td>
                <td className="text-xs">
                  {c.inboundIds.length === 0 ? (
                    <span className="text-warn">нет</span>
                  ) : (
                    <span className="text-muted">
                      {c.inboundIds.map((id) => byId.get(id)?.remark || `#${id}`).join(', ')}
                    </span>
                  )}
                </td>
                <td
                  className="whitespace-nowrap text-right text-xs text-muted"
                  title={
                    [
                      c.totalGB ? `лимит: ${bytes(c.totalGB)}` : '',
                      c.expiryTime > 0 ? `до ${dateFull(c.expiryTime)}` : '',
                    ]
                      .filter(Boolean)
                      .join(', ') || undefined
                  }
                >
                  {bytes(c.up + c.down)}
                  {c.totalGB ? ` / ${bytes(c.totalGB)}` : ''}
                </td>
                <td className="whitespace-nowrap">
                  <div className="flex justify-end">
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      title={reason ?? 'Inbound клиента'}
                      aria-label="Inbound клиента"
                      disabled={locked || !inbounds}
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
                        c.panel
                          ? 'Клиент панели удаляется в своей карточке'
                          : (reason ?? 'Удалить клиента')
                      }
                      aria-label="Удалить клиента"
                      disabled={locked || Boolean(c.panel)}
                      onClick={() => void remove(c)}
                    >
                      <Trash2 className={cn('size-3.5', !c.panel && 'text-bad')} />
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </TBody>
        </Table>
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
