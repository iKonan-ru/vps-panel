import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { randomServerName } from '@vps/protocol';
import { Dices } from 'lucide-react';
import type { InputHTMLAttributes } from 'react';

/**
 * Имя сервера с кнопкой случайного имени "Прилагательное Животное/Растение"; taken - имена других
 * серверов (повторов нет: имя - основа поддоменов панели).
 */
export function ServerNameInput({
  value,
  onChange,
  taken,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
  value: string;
  onChange: (v: string) => void;
  taken: string[];
}) {
  return (
    <div className="relative">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pr-10"
        maxLength={64}
        {...rest}
      />
      <div className="absolute inset-y-0 right-1 flex items-center">
        <Button
          size="icon-sm"
          variant="ghost"
          title="Случайное имя"
          aria-label="Случайное имя"
          disabled={rest.disabled}
          onClick={() => onChange(randomServerName(taken))}
        >
          <Dices className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
