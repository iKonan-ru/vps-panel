import { Chip } from '@/components/ui/chip';
import { deviceOf } from '@vps/protocol';
import type { GClientRow, GDevice } from '@vps/protocol';

/** Состояние привязок клиента одной строкой чипов. */
export function BindingStates({ s }: { s: GClientRow['states'] }) {
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {s.ok > 0 && (
        <Chip tone="ok" dot>
          работает {s.ok}
        </Chip>
      )}
      {s.pending > 0 && <Chip tone="muted">ждёт синхронизации {s.pending}</Chip>}
      {s.error > 0 && <Chip tone="bad">ошибок {s.error}</Chip>}
    </span>
  );
}

export const deviceTitle = (d: GDevice) =>
  [deviceOf(d.type)?.title, d.name].filter(Boolean).join(': ') || 'устройство';
