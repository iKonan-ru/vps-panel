import { Button, ButtonAnchor } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { isSafeHref } from '@/lib/safe-url';
import { useCopy } from '@/lib/use-copy';
import { Check, Copy, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';

/**
 * Ссылка во всей панели - сдвоенной кнопкой: слева переход, справа копирование (на полторы
 * секунды - галочка). Сама ссылка не показывается, она в подсказке кнопки. http(s) открывается в
 * новой вкладке, happ:// и tg:// - в приложении. copyText - если копировать нужно другое (у
 * "Добавить в Happ" - саму подписку). label - подпись, на узком экране остаётся только значок;
 * children - подпись видна всегда. wide - во всю ширину. Ссылка со схемой не из списка
 * (lib/safe-url.ts) не открывается: кнопка перехода неактивна, копирование остаётся.
 */
export function LinkButton({
  href,
  children,
  label,
  variant = 'default',
  size = 'sm',
  wide,
  title,
  copyText = href,
  copyTitle = 'Скопировать ссылку',
}: {
  href: string;
  children?: ReactNode;
  label?: string;
  variant?: 'default' | 'primary';
  size?: 'sm' | 'md';
  wide?: boolean;
  title?: string;
  copyText?: string;
  copyTitle?: string;
}) {
  const { copied, copy } = useCopy();
  const web = /^https?:/i.test(href);
  const safe = isSafeHref(href);
  const iconCls = size === 'sm' ? 'size-3.5' : 'size-4';
  const cls = cn('min-w-0 rounded-r-none', wide && 'grow justify-center');
  return (
    // без wide кнопка не сжимается: в строке с длинным текстом рядом она иначе меняла ширину и
    // место от строки к строке
    <span className={cn('inline-flex', wide ? 'flex w-full min-w-0' : 'shrink-0')}>
      {safe ? (
        <ButtonAnchor
          href={href}
          {...(web ? { target: '_blank', rel: 'noreferrer' } : {})}
          variant={variant}
          size={size}
          label={label}
          title={title ?? href}
          className={cls}
        >
          <ExternalLink className={iconCls} />
          {children}
        </ButtonAnchor>
      ) : (
        <Button
          disabled
          variant={variant}
          size={size}
          label={label}
          title="Ссылка не открывается: недопустимая схема"
          className={cls}
        >
          <ExternalLink className={iconCls} />
          {children}
        </Button>
      )}
      <Button
        size={size === 'sm' ? 'sm' : 'icon'}
        className={cn('rounded-l-none border-l-0', size === 'sm' && 'px-2')}
        title={copyTitle}
        aria-label={copyTitle}
        onClick={() => copy(copyText)}
      >
        {copied ? <Check className={cn(iconCls, 'text-ok')} /> : <Copy className={iconCls} />}
      </Button>
    </span>
  );
}
