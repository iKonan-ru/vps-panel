import { ActionPanel } from '@/components/action-output';
import { useCascades } from '@/components/server/xui-cascades';
import { EditInboundForm } from '@/components/server/xui-edit-inbound';
import { NewInboundsForm } from '@/components/server/xui-new-inbounds';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { ApiError, api } from '@/lib/api';
import { bytes, dateFull } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { XuiInboundRow } from '@vps/protocol';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

/** Что станет с выходом в Telegram, если inbound удалить или выключить. */
function exitNote(i: XuiInboundRow): string {
  if (i.telegramExit === 'primary')
    return ' Через него панель отправляет уведомления в Telegram: основной выход перейдёт на другой RAW этого сервера или на запасной выход.';
  if (i.telegramExit === 'spare')
    return ' Запасной выход панели в Telegram перейдёт на другой RAW этого сервера.';
  return '';
}

const securityTitle: Record<string, string> = { reality: 'Reality', tls: 'TLS', none: '' };

/** Inbound-ы 3X-UI: правка подписи, порта и вкл/выкл; данные - по API-токену. */
export function XuiInbounds({
  serverId,
  disabled,
  reason,
}: {
  serverId: string;
  disabled: boolean;
  reason: string | undefined;
}) {
  const qc = useQueryClient();
  const ask = useConfirm();
  const { data, error, isFetching } = useQuery({
    queryKey: ['xui-inbounds', serverId],
    queryFn: () => api<XuiInboundRow[]>(`/api/servers/${serverId}/xui/inbound-list`),
    staleTime: 20_000,
    retry: false,
  });
  const cascades = useCascades(serverId);
  /** Inbound-ы входа каскадов: меняются и удаляются в блоке "Каскад". */
  const cascadeOf = new Map(
    (cascades.data?.cascades ?? []).map((c) => [c.entryInboundId, c.exitServerName] as const),
  );
  const [edit, setEdit] = useState<XuiInboundRow | null>(null);
  const op = useAction();
  const [adding, setAdding] = useState(false);
  const [run, setRun] = useState<{ id: string; title: string } | null>(null);
  const noToken = error instanceof ApiError && error.code === 'no-token';

  /** Включение и выключение из строки; остальное - окно правки. */
  async function save(i: XuiInboundRow, body: { enable: boolean }) {
    if (!body.enable) {
      const ok = await ask({
        title: `Выключить inbound \u00ab${i.remark}\u00bb?`,
        text: `Его пользователи (${i.clients}) не смогут подключиться.${exitNote(i)}`,
        okLabel: 'Выключить',
        danger: true,
      });
      if (!ok) return false;
    }
    return op.run(async () => {
      await api(`/api/servers/${serverId}/xui/inbounds/${i.id}`, { method: 'POST', json: body });
      await qc.invalidateQueries({ queryKey: ['xui-inbounds', serverId] });
      void qc.invalidateQueries({ queryKey: ['xui', serverId] });
    });
  }

  async function remove(i: XuiInboundRow) {
    const ok = await ask({
      title: `Удалить inbound \u00ab${i.remark || `#${i.id}`}\u00bb?`,
      text: `Пользователей: ${i.clients}${i.enable ? `, сейчас онлайн: ${i.online}` : ''}. Ссылки на него пропадут из подписок, пользователям без подписки он перестанет работать.${exitNote(i)}`,
      okLabel: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    await op.run(async () => {
      await api(`/api/servers/${serverId}/xui/inbounds/${i.id}/delete`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['xui-inbounds', serverId] });
      void qc.invalidateQueries({ queryKey: ['xui', serverId] });
      void qc.invalidateQueries({ queryKey: ['xui-clients', serverId] });
    });
  }

  const list = data ?? [];
  // список перечитывается - кнопки по нему недоступны (решение по старым данным)
  const locked = disabled || op.busy || isFetching;
  return (
    <>
      {run && <ActionPanel title={run.title} actionId={run.id} onHide={() => setRun(null)} />}
      <Section
        title="Inbound"
        info={
          'Здесь добавляются соединения VLESS (RAW и XHTTP с Reality), меняются подпись, порт и включение, inbound удаляется; остальное\u00a0\u2014 в панели 3X-UI'
        }
        extra={data && <Chip>{list.length}</Chip>}
        actions={
          <Button
            size="sm"
            label="Добавить соединения VLESS"
            short="Добавить"
            title={noToken ? 'Нужен API-токен 3X-UI' : reason}
            disabled={locked || !data}
            onClick={() => {
              op.setError(null);
              setAdding(true);
            }}
          >
            <Plus className="size-3.5" />
          </Button>
        }
      >
        {op.error && !edit && (
          <div className="p-4 pb-0">
            <Alert tone="bad">{op.error}</Alert>
          </div>
        )}
        {error && (
          <div className="px-4 py-3 text-[13px] text-muted">
            {noToken ? 'Нужен API-токен 3X-UI' : `Не удалось получить inbound: ${error.message}`}
          </div>
        )}
        {!data && !error && (
          <div className="px-4 py-3 text-[13px] text-muted">
            {isFetching ? 'Загрузка\u2026' : 'Нет данных'}
          </div>
        )}
        {data && list.length === 0 && (
          <div className="px-4 py-3 text-[13px] text-muted">Inbound нет</div>
        )}
        {list.map((i) => (
          // всё по верхнему краю; плашки на узком экране - всегда своей строкой под именем, чтобы
          // строки с разным числом плашек не выглядели по-разному
          <div
            key={i.id}
            className="flex items-start gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
          >
            <Switch
              checked={i.enable}
              disabled={locked || i.node}
              label={`Inbound ${i.remark || `#${i.id}`}`}
              className="mt-0.5"
              onChange={() => void save(i, { enable: !i.enable })}
            />
            <div className="min-w-0 grow">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
                <span className="flex min-w-0 items-baseline gap-2">
                  <span className="min-w-0 truncate font-medium">{i.remark || `#${i.id}`}</span>
                  <span className="shrink-0 font-mono text-xs text-muted">
                    {i.listen && i.listen !== '0.0.0.0' ? `${i.listen}:` : ''}
                    {i.port}
                  </span>
                </span>
                <span className="flex flex-wrap items-center gap-1.5 max-md:basis-full">
                  <Chip>
                    {[i.protocol, i.network, securityTitle[i.security] ?? i.security]
                      .filter(Boolean)
                      .join(' / ')}
                  </Chip>
                  {!i.enable && <Chip tone="muted">выключен</Chip>}
                  {i.node && <Chip title="inbound другого узла группы 3X-UI">другой узел</Chip>}
                  {i.excluded && (
                    <Chip
                      tone="warn"
                      title={
                        'Исключён в разделе \u00abКлиенты\u00bb: клиенты панели сюда не добавляются'
                      }
                    >
                      без клиентов панели
                    </Chip>
                  )}
                  {i.telegramExit && (
                    <Chip
                      tone={i.telegramExit === 'primary' ? 'accent' : 'muted'}
                      title={
                        i.telegramExit === 'primary'
                          ? 'Через этот inbound панель отправляет уведомления в Telegram'
                          : 'Запасной выход панели в Telegram'
                      }
                    >
                      {i.telegramExit === 'primary'
                        ? 'выход панели в Telegram'
                        : 'запасной выход панели в Telegram'}
                    </Chip>
                  )}
                  {i.excludeFromSub && <Chip tone="muted">не в подписке</Chip>}
                  {cascadeOf.has(i.id) && (
                    <Chip tone="accent">{`каскад \u2192 ${cascadeOf.get(i.id) ?? ''}`}</Chip>
                  )}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {[
                  i.sni && `SNI ${i.sni}`,
                  `пользователей: ${i.clients}${i.clientsOff ? ` (выключено: ${i.clientsOff})` : ''}`,
                  i.panelClients ? `из панели: ${i.panelClients}` : '',
                  i.enable ? `онлайн: ${i.online}` : '',
                  `трафик: ${bytes(i.up + i.down)}${i.total ? ` из ${bytes(i.total)}` : ''}`,
                  i.expiryTime ? `до ${dateFull(i.expiryTime)}` : '',
                ]
                  .filter(Boolean)
                  .join(', ')}
              </div>
            </div>
            <Button
              size="icon-sm"
              variant="ghost"
              title={
                i.node
                  ? 'Inbound другого узла: правится на нём'
                  : cascadeOf.has(i.id)
                    ? 'Меняется в блоке \u00abКаскад\u00bb'
                    : reason
              }
              aria-label="Изменить inbound"
              disabled={locked || i.node || cascadeOf.has(i.id)}
              onClick={() => {
                op.setError(null);
                setEdit(i);
              }}
            >
              <Pencil className="size-3.5" />
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              title={
                i.node
                  ? 'Inbound другого узла: удаляется на нём'
                  : cascadeOf.has(i.id)
                    ? 'Удаляется в блоке \u00abКаскад\u00bb'
                    : (reason ?? 'Удалить inbound')
              }
              aria-label="Удалить inbound"
              disabled={locked || i.node || cascadeOf.has(i.id)}
              onClick={() => void remove(i)}
            >
              <Trash2 className="size-3.5 text-bad" />
            </Button>
          </div>
        ))}
        <Dialog
          open={edit !== null}
          onClose={() => setEdit(null)}
          title={edit ? `Inbound ${edit.remark || `#${edit.id}`}` : ''}
        >
          {edit && (
            <EditInboundForm
              key={edit.id}
              serverId={serverId}
              inbound={edit}
              disabled={locked}
              onCancel={() => setEdit(null)}
              onStarted={(id) => {
                setEdit(null);
                setRun({ id, title: `Inbound ${edit.remark || `#${edit.id}`}` });
              }}
            />
          )}
        </Dialog>
        <Dialog open={adding} onClose={() => setAdding(false)} title="Добавить соединения VLESS">
          {adding && (
            <NewInboundsForm
              serverId={serverId}
              disabled={locked}
              onCancel={() => setAdding(false)}
              onStarted={(id) => {
                setAdding(false);
                setRun({ id, title: 'Новые соединения VLESS' });
              }}
            />
          )}
        </Dialog>
      </Section>
    </>
  );
}
