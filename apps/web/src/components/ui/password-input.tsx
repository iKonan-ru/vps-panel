import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { useCopy } from '@/lib/use-copy';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';

/** Поле пароля: значение скрыто точками, справа кнопки показать и скопировать. */
export function PasswordInput({
  className,
  value,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & { value: string }) {
  const [shown, setShown] = useState(false);
  const { copied, copy: copyText } = useCopy();
  const copy = () => copyText(value);
  return (
    <div className="relative">
      <Input
        type={shown ? 'text' : 'password'}
        value={value}
        className={cn('pr-16 font-mono', className)}
        {...rest}
      />
      <div className="absolute inset-y-0 right-1 flex items-center">
        <Button
          size="icon-sm"
          variant="ghost"
          title={shown ? 'Скрыть' : 'Показать'}
          aria-label={shown ? 'Скрыть' : 'Показать'}
          onClick={() => setShown(!shown)}
        >
          {shown ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
        </Button>
        <Button
          size="icon-sm"
          variant="ghost"
          title="Скопировать"
          aria-label="Скопировать"
          disabled={!value}
          onClick={copy}
        >
          {copied ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
        </Button>
      </div>
    </div>
  );
}
