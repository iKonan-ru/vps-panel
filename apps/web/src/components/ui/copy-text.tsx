import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { useCopy } from '@/lib/use-copy';
import { Check, Copy } from 'lucide-react';

/** Текст, который копируется по клику, с краткой отметкой об успехе. */
export function CopyText({
  text,
  title = 'Скопировать',
  className,
}: { text: string; title?: string; className?: string }) {
  const { copied, copy, error } = useCopy();
  return (
    <span className="inline-flex max-w-full flex-wrap items-center gap-2">
      <Button
        variant="link"
        title={title}
        aria-label={title}
        className={cn(
          'max-w-full gap-1 font-mono text-muted hover:text-text hover:no-underline',
          className,
        )}
        onClick={(e) => {
          e.preventDefault();
          copy(text);
        }}
      >
        <span className="min-w-0">{text}</span>
        {copied ? (
          <Check aria-hidden="true" className="size-3.5 shrink-0 animate-check text-ok" />
        ) : (
          <Copy aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
        )}
      </Button>
      <span aria-live="polite" className={error ? 'text-xs' : 'sr-only'}>
        {copied ? 'Скопировано' : error}
      </span>
    </span>
  );
}
