import { cn } from '@/lib/cn';
import type { HTMLAttributes } from 'react';

/** Заголовок страницы: списки и настройки - обычный, карточка объекта (сервер, команда) - hero. */
export function PageTitle({
  className,
  hero,
  ...rest
}: HTMLAttributes<HTMLHeadingElement> & { hero?: boolean }) {
  return <h1 className={cn('font-semibold', hero ? 'text-2xl' : 'text-lg', className)} {...rest} />;
}
