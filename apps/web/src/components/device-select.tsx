import { Select } from '@/components/ui/select';
import { DEVICES } from '@vps/protocol';

/** Выбор устройства клиента; пусто - не указано. */
export function DeviceSelect({
  id,
  value,
  onChange,
  className,
}: { id?: string; value: string; onChange: (v: string) => void; className?: string }) {
  return (
    <Select
      id={id}
      aria-label="Устройство"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    >
      <option value="">устройство не указано</option>
      {DEVICES.map((d) => (
        <option key={d.id} value={d.id}>
          {d.title}
        </option>
      ))}
    </Select>
  );
}
