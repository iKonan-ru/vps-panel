import { Button } from '@/components/ui/button';
import { useCopy } from '@/lib/use-copy';

/** Точное имя для ручного подтверждения; копирование не меняет поле ввода. */
export function CopyName({ name }: { name: string }) {
  const { copy, copied, error } = useCopy();
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <Button
        variant="link"
        className="font-mono whitespace-pre-wrap break-all"
        aria-label={`Скопировать имя ${name}`}
        onClick={(e) => {
          e.preventDefault();
          copy(name);
        }}
      >
        {name}
      </Button>
      <span aria-live="polite" className="text-xs">
        {copied ? 'Скопировано' : error}
      </span>
    </span>
  );
}
