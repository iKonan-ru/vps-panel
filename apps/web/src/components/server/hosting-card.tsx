import {
  HostingFields,
  type HostingForm,
  formToHosting,
  hostingToForm,
} from '@/components/server/hosting-form';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { LinkButton } from '@/components/ui/link-button';
import { actions } from '@/lib/actions';
import { countryLabel } from '@/lib/countries';
import { dateShort, daysUntil, daysWord, money, paymentSoon, perMonth } from '@/lib/format';
import { useQueryClient } from '@tanstack/react-query';
import type { Hosting } from '@vps/protocol';
import { Pencil } from 'lucide-react';
import { type FormEvent, useState } from 'react';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="text-xs text-muted">{label}</span>
      <span className="min-w-0 break-words">{children}</span>
    </>
  );
}

/** Блок "Хостинг" с редактированием в диалоге. */
export function HostingCard({ serverId, hosting }: { serverId: string; hosting: Hosting }) {
  const [open, setOpen] = useState(false);
  const h = hosting;
  const days = daysUntil(h.nextPaymentAt);
  const empty = !h.provider && !h.providerServerName && !h.country && h.price === null && !h.notes;
  return (
    <Card className="flex flex-col gap-2.5 p-4">
      <div className="flex items-center">
        <div className="font-semibold">Хостинг</div>
        <div className="grow" />
        <Button size="sm" onClick={() => setOpen(true)} label="Изменить">
          <Pencil className="size-3.5" />
        </Button>
      </div>
      {empty ? (
        <div className="text-[13px] text-muted">Не заполнено</div>
      ) : (
        <div className="grid grid-cols-[120px_1fr] gap-x-3 gap-y-2 text-[13px]">
          <Row label="Провайдер">
            <span className="flex flex-wrap items-center gap-2">
              {h.provider || '-'}
              {h.providerUrl && <LinkButton href={h.providerUrl}>Панель хостера</LinkButton>}
            </span>
          </Row>
          {h.providerServerName && <Row label="Сервер у хостера">{h.providerServerName}</Row>}
          {h.country && <Row label="Страна">{countryLabel(h.country)}</Row>}
          {h.price !== null && (
            <Row label="Оплата">
              {money(h.price, h.currency, h.billingMonths)}
              {perMonth(h.price, h.currency, h.billingMonths) && (
                <span className="text-muted">
                  {' '}
                  ({perMonth(h.price, h.currency, h.billingMonths)})
                </span>
              )}
              {h.nextPaymentAt && (
                <span className={paymentSoon(days) ? 'text-warn' : 'text-muted'}>
                  {', следующая '}
                  {dateShort(h.nextPaymentAt)}
                  {paymentSoon(days) && ` (${daysWord(days)})`}
                </span>
              )}
            </Row>
          )}
          {h.notes && (
            <Row label="Заметки">
              <span className="text-muted">{h.notes}</span>
            </Row>
          )}
        </div>
      )}
      {/* окно монтируется при открытии: каждое открытие - с чистой формой, без прошлой ошибки */}
      {open && (
        <HostingDialog serverId={serverId} hosting={h} open={open} onClose={() => setOpen(false)} />
      )}
    </Card>
  );
}

function HostingDialog({
  serverId,
  hosting,
  open,
  onClose,
}: { serverId: string; hosting: Hosting; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState<HostingForm>(() => hostingToForm(hosting));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<HostingForm>) => setF((s) => ({ ...s, ...patch }));

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await actions.patchServer(serverId, { hosting: formToHosting(f) });
      await qc.invalidateQueries({ queryKey: ['servers'] });
      onClose();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Хостинг" wide>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <HostingFields f={f} set={set} />
        {error && <Alert tone="bad">{error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={busy}>
            Сохранить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
