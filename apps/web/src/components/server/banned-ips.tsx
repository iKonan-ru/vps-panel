import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import type { ServerSummary } from '@vps/protocol';
import { useState } from 'react';

type Audit = NonNullable<ServerSummary['audit']>;

/**
 * Строка fail2ban в блоке безопасности: плашки по jail со счётчиком банов.
 * Клик по плашке открывает окно "Откуда ломятся" с адресами в бане - на основном экране
 * этот список не нужен.
 */
export function BannedIps({ audit }: { audit: Audit }) {
  const [open, setOpen] = useState(false);
  const jails = audit.jails ?? [];
  if (jails.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted">
      <span>fail2ban:</span>
      {jails.map((j) => (
        <button
          key={j.name}
          type="button"
          className="rounded-full focus-visible:outline-2 focus-visible:outline-accent"
          title={`всего банов ${j.totalBanned}, неудачных в окне ${j.failed}. Нажми, чтобы увидеть адреса`}
          onClick={() => setOpen(true)}
        >
          <Chip
            tone={j.banned > 0 ? 'warn' : 'muted'}
            className="cursor-pointer hover:brightness-125"
          >
            {j.name}: {j.banned} в бане
          </Chip>
        </button>
      ))}
      <Dialog open={open} onClose={() => setOpen(false)} title="Откуда ломятся">
        {jails.map((j) => (
          <div key={j.name} className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="font-mono font-medium">{j.name}</span>
              <span className="text-xs text-muted">
                в бане {j.banned}, всего забанено {j.totalBanned}, неудачных попыток в окне{' '}
                {j.failed}
              </span>
            </div>
            {(j.bannedIps ?? []).length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {j.bannedIps.map((ip) => (
                  <span
                    key={ip}
                    className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-xs"
                  >
                    {ip}
                  </span>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted">Сейчас никого в бане.</div>
            )}
          </div>
        ))}
        <div className="flex justify-end">
          <Button onClick={() => setOpen(false)}>Закрыть</Button>
        </div>
      </Dialog>
    </div>
  );
}
