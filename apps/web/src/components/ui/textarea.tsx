import { cn } from '@/lib/cn';
import type { TextareaHTMLAttributes } from 'react';

export function Textarea({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        'well field min-h-[80px] w-full rounded-lg border border-border bg-bg px-3 py-2 text-sm text-text',
        'placeholder:text-muted focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-50',
        className,
      )}
      {...rest}
    />
  );
}
