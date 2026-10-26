import { Switch } from '@/components/ui/switch';

/** Фильтр списка пользователей сервиса: только те, кто сейчас в сети; count - сколько их. */
export function OnlineOnly({
  on,
  onChange,
  count,
}: {
  on: boolean;
  onChange: (on: boolean) => void;
  count: number;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-xs text-muted">
      <span>Только в сети: {count}</span>
      <Switch checked={on} onChange={() => onChange(!on)} label="Только в сети" />
    </div>
  );
}
