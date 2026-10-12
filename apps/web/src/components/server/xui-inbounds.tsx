import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { ApiError, api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { type FormEvent, useState } from 'react';

/** Inbound 3X-UI для вкладки (GET /xui/inbound-list): без настроек клиентов. */
export interface Inbound {
  id: number;
  remark: string;
  enable: boolean;
  protocol: string;
  port: number;
  listen: string;
  network: string;
  security: string;
  sni: string;
  node: boolean;
  up: number;
  down: number;
  total: number;
  expiryTime: number;
  excludeFromSub: boolean;
  excluded: boolean;
  clients: number;
  clientsOff: number;
  online: number;
  panelClients: number;
}

const securityTitle: Record<string, string> = { reality: 'Reality', tls: 'TLS', none: '' };

/**
 * Блок "Inbound-ы" вкладки 3X-UI: что слушает xray, клиенты и трафик; правка - подпись, порт,
 * вкл/выкл (остальное - в панели 3X-UI). Данные - по API-токену; нет токена - подсказка.
 */
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
    queryFn: () => api<Inbound[]>(`/api/servers/${serverId}/xui/inbound-list`),
    staleTime: 20_000,
    retry: false,
  });
  const [edit, setEdit] = useState<Inbound | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noToken = error instanceof ApiError && error.code === 'no-token';

  async function save(i: Inbound, body: { enable?: boolean; remark?: string; port?: number }) {
    if (body.enable === false || (body.port !== undefined && body.port !== i.port)) {
      const ok = await ask({
        title:
          body.enable === false
            ? `Выключить inbound \u00ab${i.remark}\u00bb?`
            : `Сменить порт на ${body.port}?`,
        text:
          body.enable === false
            ? `Его клиенты (${i.clients}) не смогут подключиться`
            : 'Подписки панели получат новый порт сами, остальным клиентам нужна новая ссылка',
        okLabel: body.enable === false ? 'Выключить' : 'Сменить',
        danger: true,
      });
      if (!ok) return false;
    }
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/servers/${serverId}/xui/inbounds/${i.id}`, { method: 'POST', json: body });
      await qc.invalidateQueries({ queryKey: ['xui-inbounds', serverId] });
      void qc.invalidateQueries({ queryKey: ['xui', serverId] });
      return true;
    } catch (e) {
      setErr((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const list = data ?? [];
  return (
    <Section
      title="Inbound"
      info={'Здесь меняются подпись, порт и включение, остальное\u00a0\u2014 в панели 3X-UI'}
      extra={data && <Chip>{list.length}</Chip>}
    >
      {err && !edit && (
        <div className="p-4 pb-0">
          <Alert tone="bad">{err}</Alert>
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
        <div
          key={i.id}
          className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0"
        >
          <Switch
            checked={i.enable}
            disabled={disabled || busy || i.node}
            label={`Inbound ${i.remark || `#${i.id}`}`}
            onChange={() => void save(i, { enable: !i.enable })}
          />
          <div className="min-w-0 grow">
            <div className="flex flex-wrap items-center gap-2 text-[13px]">
              <span className="font-medium">{i.remark || `#${i.id}`}</span>
              <span className="font-mono text-xs text-muted">
                {i.listen && i.listen !== '0.0.0.0' ? `${i.listen}:` : ''}
                {i.port}
              </span>
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
              {i.excludeFromSub && <Chip tone="muted">не в подписке</Chip>}
            </div>
            <div className="text-xs text-muted">
              {[
                i.sni && `SNI ${i.sni}`,
                `клиентов: ${i.clients}${i.clientsOff ? ` (выключено: ${i.clientsOff})` : ''}`,
                i.panelClients ? `из панели: ${i.panelClients}` : '',
                i.enable ? `онлайн: ${i.online}` : '',
                `трафик: ${bytes(i.up + i.down)}${i.total ? ` из ${bytes(i.total)}` : ''}`,
                i.expiryTime ? `до ${new Date(i.expiryTime).toLocaleDateString('ru-RU')}` : '',
              ]
                .filter(Boolean)
                .join(', ')}
            </div>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            title={i.node ? 'Inbound другого узла: правится на нём' : reason}
            aria-label="Изменить inbound"
            disabled={disabled || busy || i.node}
            onClick={() => {
              setErr(null);
              setEdit(i);
            }}
          >
            <Pencil className="size-3.5" />
          </Button>
        </div>
      ))}
      <Dialog
        open={edit !== null}
        onClose={() => setEdit(null)}
        title={edit ? `Inbound ${edit.remark || `#${edit.id}`}` : ''}
      >
        {edit && (
          <EditForm
            key={edit.id}
            inbound={edit}
            taken={list.filter((x) => x.id !== edit.id).map((x) => x.port)}
            busy={busy}
            error={err}
            onCancel={() => setEdit(null)}
            onSave={async (body) => {
              if (await save(edit, body)) setEdit(null);
            }}
          />
        )}
      </Dialog>
    </Section>
  );
}

function EditForm({
  inbound,
  taken,
  busy,
  error,
  onCancel,
  onSave,
}: {
  inbound: Inbound;
  taken: number[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onSave: (body: { remark?: string; port?: number }) => Promise<void>;
}) {
  const [remark, setRemark] = useState(inbound.remark);
  const [port, setPort] = useState(String(inbound.port));
  const n = Number(port);
  const portBad = !Number.isInteger(n) || n < 1 || n > 65535;
  const portTaken = !portBad && n !== inbound.port && taken.includes(n);
  const body: { remark?: string; port?: number } = {};
  if (remark.trim() !== inbound.remark) body.remark = remark.trim();
  if (!portBad && n !== inbound.port) body.port = n;
  const changed = Object.keys(body).length > 0;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (changed && !portBad && !portTaken) void onSave(body);
  };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Field label="Подпись" htmlFor="xui-in-remark">
        <Input
          id="xui-in-remark"
          value={remark}
          maxLength={100}
          onChange={(e) => setRemark(e.target.value)}
        />
      </Field>
      <Field
        label="Порт"
        htmlFor="xui-in-port"
        hint="порт проверяется на занятость: inbound на занятом порту останавливает весь Xray"
      >
        <Input
          id="xui-in-port"
          type="number"
          min={1}
          max={65535}
          value={port}
          onChange={(e) => setPort(e.target.value)}
          className="font-mono"
        />
      </Field>
      {portTaken && <Alert tone="bad">Порт {n} занят другим inbound</Alert>}
      {error && <Alert tone="bad">{error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel}>Отмена</Button>
        <Button type="submit" variant="primary" disabled={busy || !changed || portBad || portTaken}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}
