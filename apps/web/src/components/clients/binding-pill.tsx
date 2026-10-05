import { deviceTitle } from '@/components/clients/binding-states';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import type { GBinding, GDevice } from '@vps/protocol';
import { QrCode as QrCodeIcon } from 'lucide-react';

/** Привязки клиента к серверам: порядок сервисов, группировка по серверу, плашка привязки. */

const serviceOrder: Record<GBinding['service'], number> = {
  xui: 0,
  mtproxyl: 1,
  wdtt: 2,
  awg: 3,
  openflux: 4,
  naive: 5,
};

/** Привязки по серверам (по имени), внутри - VLESS, MTProxy, WDTT, AWG. */
export function byServer(bindings: GBinding[]): [string, GBinding[]][] {
  const m = new Map<string, GBinding[]>();
  for (const b of bindings) m.set(b.serverId, [...(m.get(b.serverId) ?? []), b]);
  return [...m.entries()]
    .map(([id, list]) => {
      const sorted = [...list].sort((x, y) => serviceOrder[x.service] - serviceOrder[y.service]);
      return [id, sorted] as [string, GBinding[]];
    })
    .sort((x, y) => (x[1][0]?.serverName ?? '').localeCompare(y[1][0]?.serverName ?? ''));
}

export function pillLabel(b: GBinding, device: GDevice | undefined) {
  if (b.service === 'xui') return b.xuiInbounds ? 'VLESS (свой набор)' : 'VLESS';
  if (b.service === 'mtproxyl') return 'MTProxy';
  if (b.service === 'wdtt') return 'WDTT';
  if (b.service === 'naive') return 'Браузер';
  if (b.service === 'openflux') return `OpenFlux${device ? ` - ${deviceTitle(device)}` : ''}`;
  return `AWG ${b.awg?.major ?? '3'}.x${device ? ` - ${deviceTitle(device)}` : ''}`;
}

/**
 * Услуга на сервере: точка состояния (зелёная - работает, серая - ждёт сверки, красная - ошибка)
 * и подпись; подробности - в подсказке. Кнопка открывает подписку (VLESS), ссылки (MTProxy) или
 * конфиг (AWG) с QR.
 */
export function BindingPill({
  b,
  device,
  onOpen,
}: { b: GBinding; device: GDevice | undefined; onOpen: (() => void) | undefined }) {
  const label = pillLabel(b, device);
  const state = b.state === 'ok' ? 'работает' : b.state === 'pending' ? 'ждёт сверки' : 'ошибка';
  const detail =
    b.state === 'ok' && b.service === 'xui'
      ? `${b.ref}, ссылок ${b.linkCount}, сверено ${ago(b.updatedAt)}`
      : '';
  const custom = b.xuiInbounds
    ? `свой набор inbound-ов (${b.xuiInbounds.length}) - правится во вкладке 3X-UI сервера`
    : '';
  const title = [`${label}: ${state}`, detail, custom].filter(Boolean).join('; ');
  const opens = b.service === 'awg' ? 'конфиг' : b.service === 'xui' ? 'подписка' : 'ссылки';
  const dot = (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        b.state === 'ok' ? 'bg-ok' : b.state === 'error' ? 'bg-bad' : 'bg-muted',
      )}
    />
  );
  if (onOpen)
    return (
      <Button size="sm" onClick={onOpen} title={`${title}; ${opens} и QR`}>
        {dot}
        {label}
        <QrCodeIcon className="size-3.5 text-muted" />
      </Button>
    );
  return (
    <span
      title={title}
      className="inline-flex h-7.5 items-center gap-1.5 rounded-lg border border-border px-2.5 text-[13px]"
    >
      {dot}
      {label}
    </span>
  );
}
