import { InfoTip } from '@/components/ui/info-tip';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/cn';
import type { ReactNode } from 'react';

/** Поле формы: подпись сверху, hint - за иконкой рядом; htmlFor связывает подпись с полем. */
export function Field({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <div className="flex min-w-0 items-center gap-1">
        <Label htmlFor={htmlFor}>{label}</Label>
        {hint && <InfoTip>{hint}</InfoTip>}
      </div>
      {children}
    </div>
  );
}
