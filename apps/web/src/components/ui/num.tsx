import { useTween } from '@/lib/use-tween';

/** Число, плавно доходящее до нового значения; format - как показать. */
export function Num({
  value,
  format = (v) => String(Math.round(v)),
}: {
  value: number;
  format?: (v: number) => string;
}) {
  return <span className="tabular-nums">{format(useTween(value))}</span>;
}
