import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { useCopy } from '@/lib/use-copy';
import { Check, Copy, Dices, Eye, EyeOff } from 'lucide-react';
import { type InputHTMLAttributes, useState } from 'react';

/** Поле пароля с кнопками показать и скопировать; пароль от onGenerate сразу виден. */
export function PasswordInput({
  className,
  value,
  onGenerate,
  ...rest
}: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> & {
  value: string;
  onGenerate?: (() => void) | undefined;
}) {
  const [shown, setShown] = useState(false);
  const { copied, copy: copyText } = useCopy();
  const copy = () => copyText(value);
  return (
    <div className="relative">
      <Input
        type={shown ? 'text' : 'password'}
        value={value}
        className={cn(onGenerate ? 'pr-24 font-mono' : 'pr-16 font-mono', className)}
        {...rest}
      />
      <div className="absolute inset-y-0 right-1 flex items-center">
        {onGenerate && (
          <Button
            size="icon-sm"
            variant="ghost"
            title="Сгенерировать пароль"
            aria-label="Сгенерировать пароль"
            disabled={rest.disabled}
            onClick={() => {
              onGenerate();
              setShown(true);
            }}
          >
            <Dices className="size-3.5" />
          </Button>
        )}
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
