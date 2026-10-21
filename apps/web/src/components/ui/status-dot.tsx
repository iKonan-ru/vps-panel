import { cn } from '@/lib/cn';

/**
 * Точка клиента или пользователя сервиса: контур - включён, заливка - сейчас в сети; выключенный -
 * серый контур. Одинаково в 3X-UI и MTProxyL.
 */
export function StatusDot({
  enabled,
  online,
  className,
}: {
  enabled: boolean;
  online: boolean;
  className?: string;
}) {
  const label = !enabled ? 'выключен' : online ? 'в сети' : 'включён, не в сети';
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        'inline-block size-2.5 shrink-0 rounded-full border-2',
        !enabled ? 'border-muted' : online ? 'glossy-dot border-ok bg-ok text-ok' : 'border-ok',
        className,
      )}
    />
  );
}
