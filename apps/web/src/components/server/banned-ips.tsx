import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import type { ServerSummary } from '@vps/protocol';
import { X } from 'lucide-react';
import { useState } from 'react';

type Audit = NonNullable<ServerSummary['audit']>;

/**
 * Jail-ы, которые не показываются: 3x-ipl (ограничение адресов 3X-UI) и xui-panel (вход в
 * панель 3X-UI) - панели 3X-UI открыты только на 127.0.0.1, снаружи в них не ломятся.
 */
const HIDDEN = new Set(['3x-ipl', 'xui-panel']);

/** Название jail для человека. */
const TITLES: Record<string, string> = { sshd: 'SSH', 'vps-panel': 'Вход в панель' };
const jailTitle = (name: string) => TITLES[name] ?? name;

/**
 * Строка fail2ban в блоке "Обслуживание": плашки по jail со счётчиком банов. Клик открывает
 * окно с адресами в бане; бан снимается кнопкой у адреса.
 */
export function BannedIps({
  audit,
  serverId,
  disabled,
  reason,
}: {
  audit: Audit;
  serverId: string;
  /** Сервер не в сети или занят действием. */
  disabled: boolean;
  reason?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  // адреса, с которых бан уже снят: до свежего снимка агента они ещё в списке
  const [gone, setGone] = useState<Set<string>>(new Set());
  const unban = useAction();
  const qc = useQueryClient();
  const jails = (audit.jails ?? []).filter((j) => !HIDDEN.has(j.name));
  if (jails.length === 0) return null;
  const ipsOf = (j: (typeof jails)[number]) =>
    (j.bannedIps ?? []).filter((ip) => !gone.has(`${j.name} ${ip}`));

  function remove(jail: string, ip: string) {
    void unban.run(async () => {
      await api(`/api/servers/${serverId}/fail2ban/unban`, {
        method: 'POST',
        json: { jail, ip },
      });
      setGone((g) => new Set(g).add(`${jail} ${ip}`));
      await qc.invalidateQueries({ queryKey: ['servers', serverId] });
    });
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5 border-t border-border px-4 py-2.5 text-xs text-muted">
      <span>fail2ban:</span>
      {jails.map((j) => (
        <button
          key={j.name}
          type="button"
          className="rounded-full focus-visible:outline-2 focus-visible:outline-accent"
          title={`Всего банов: ${j.totalBanned}, неудачных попыток: ${j.failed}`}
          onClick={() => setOpen(true)}
        >
          <Chip
            tone={ipsOf(j).length > 0 ? 'warn' : 'muted'}
            className="cursor-pointer hover:brightness-125"
          >
            {jailTitle(j.name)}: {ipsOf(j).length > 0 ? ipsOf(j).length : j.banned} в бане
          </Chip>
        </button>
      ))}
      <Dialog open={open} onClose={() => setOpen(false)} title="Заблокированные адреса">
        {unban.error && <Alert tone="bad">{unban.error}</Alert>}
        {jails.map((j) => {
          const ips = ipsOf(j);
          return (
            <div key={j.name} className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium" title={`jail ${j.name}`}>
                  {jailTitle(j.name)}
                </span>
                <span className="text-xs text-muted">
                  в бане: {ips.length}, всего: {j.totalBanned}, неудачных попыток: {j.failed}
                </span>
              </div>
              {ips.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {ips.map((ip) => (
                    <span
                      key={ip}
                      className="inline-flex items-center gap-1 rounded-md bg-surface-2 py-0.5 pr-0.5 pl-1.5 font-mono text-xs"
                    >
                      {ip}
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-1"
                        disabled={disabled || unban.busy}
                        title={disabled ? reason : undefined}
                        aria-label={`Снять бан с ${ip}`}
                        onClick={() => remove(j.name, ip)}
                      >
                        <X className="size-3.5" />
                      </Button>
                    </span>
                  ))}
                </div>
              ) : (
                <div className="text-xs text-muted">Сейчас в бане никого нет</div>
              )}
            </div>
          );
        })}
        <div className="flex justify-end">
          <Button onClick={() => setOpen(false)}>Закрыть</Button>
        </div>
      </Dialog>
    </div>
  );
}
