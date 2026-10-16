import { cn } from '@/lib/cn';
import type { HTMLAttributes, TableHTMLAttributes } from 'react';

/** Таблица в своём блоке прокрутки: на узком экране она не раздвигает страницу. */
export function Table({ className, ...rest }: TableHTMLAttributes<HTMLTableElement>) {
  return (
    <div className="w-full min-w-0 overflow-x-auto">
      <table className={cn('w-full border-collapse text-[13px]', className)} {...rest} />
    </div>
  );
}

export function THead({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <thead
      className={cn(
        'text-left text-xs text-muted [&>tr>th]:whitespace-nowrap [&>tr>th]:border-b [&>tr>th]:border-border [&>tr>th]:px-4 [&>tr>th]:py-2.5 [&>tr>th]:font-medium',
        className,
      )}
      {...rest}
    />
  );
}

export function TBody({ className, ...rest }: HTMLAttributes<HTMLTableSectionElement>) {
  return (
    <tbody
      className={cn(
        '[&>tr>td]:border-b [&>tr>td]:border-border [&>tr>td]:px-4 [&>tr>td]:py-2 [&>tr:last-child>td]:border-b-0',
        className,
      )}
      {...rest}
    />
  );
}
