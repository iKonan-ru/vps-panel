import { cn } from '@/lib/cn';
import { createLink } from '@tanstack/react-router';
import type { AnchorHTMLAttributes, ButtonHTMLAttributes, ReactNode, Ref } from 'react';

type Variant = 'default' | 'primary' | 'danger' | 'ghost' | 'link';
type Size = 'md' | 'sm' | 'icon' | 'icon-sm';

const variants: Record<Variant, string> = {
  default: 'border border-border bg-surface-2 text-text hover:bg-border/60',
  primary: 'border border-accent bg-accent text-white hover:brightness-110',
  danger: 'border border-bad/40 bg-surface-2 text-bad hover:bg-bad/10',
  ghost: 'border border-transparent bg-transparent text-muted hover:bg-surface-2 hover:text-text',
  // текстовая ссылка-кнопка внутри текста и таблиц: без рамки и высоты
  link: 'h-auto rounded-none border-0 bg-transparent p-0 text-accent hover:underline',
};
const sizes: Record<Size, string> = {
  md: 'h-9 px-3.5 text-sm gap-2',
  sm: 'h-7.5 px-2.5 text-[13px] gap-1.5',
  icon: 'h-9 w-9 justify-center',
  'icon-sm': 'h-7 w-7 justify-center',
};
/** На узком экране кнопка с label (без short) сжимается до квадрата с иконкой. */
const compact: Record<Size, string> = {
  md: 'max-md:w-9 max-md:px-0 max-md:justify-center',
  sm: 'max-md:w-7.5 max-md:px-0 max-md:justify-center',
  icon: '',
  'icon-sm': '',
};

/**
 * Классы кнопки отдельно от тега: ссылка, которая выглядит как кнопка, рисуется ссылкой с этими
 * классами (кнопка внутри ссылки HTML не допускает: две остановки Tab, ссылка без имени).
 */
export function buttonClass({
  variant = 'default',
  size = 'md',
  labelled = false,
  className,
}: {
  variant?: Variant | undefined;
  size?: Size | undefined;
  labelled?: boolean;
  className?: string | undefined;
} = {}) {
  return cn(
    'inline-flex shrink-0 items-center whitespace-nowrap rounded-lg font-medium transition-[color,background-color,border-color,scale] enabled:active:scale-[0.97]',
    'disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent',
    sizes[size],
    variants[variant],
    labelled && compact[size],
    className,
  );
}

/** Иконка и подпись label, скрытая на узком экране; short - подпись, которая там остаётся. */
function Content({
  label,
  short,
  children,
}: { label?: ReactNode; short?: ReactNode; children?: ReactNode }) {
  return (
    <>
      {children}
      {short !== undefined && <span className="md:hidden">{short}</span>}
      {label !== undefined && <span className="hidden md:inline">{label}</span>}
    </>
  );
}

interface Look {
  variant?: Variant;
  size?: Size;
  /** Подпись: на широком экране рядом с иконкой, на узком - в title и aria-label. */
  label?: ReactNode;
  /** Короткая подпись, видимая на узком экране вместо одного значка. */
  short?: ReactNode;
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Подпись: на широком экране рядом с иконкой, на узком - в title и aria-label. */
  label?: ReactNode;
  /** Короткая подпись, видимая на узком экране вместо одного значка. */
  short?: ReactNode;
}

export function Button({
  className,
  variant = 'default',
  size = 'md',
  type = 'button',
  label,
  short,
  children,
  title,
  ...rest
}: ButtonProps) {
  const labelText = typeof label === 'string' ? label : undefined;
  return (
    <button
      type={type}
      title={title ?? labelText}
      aria-label={rest['aria-label'] ?? labelText}
      className={buttonClass({
        variant,
        size,
        labelled: label !== undefined && short === undefined,
        className,
      })}
      {...rest}
    >
      <Content label={label} short={short}>
        {children}
      </Content>
    </button>
  );
}

/** <a> с видом кнопки: основа ButtonLink (createLink передаёт ему href и обработчики роутера). */
function ButtonA({
  variant,
  size,
  label,
  short,
  className,
  children,
  title,
  ref,
  ...rest
}: Look & AnchorHTMLAttributes<HTMLAnchorElement> & { ref?: Ref<HTMLAnchorElement> }) {
  const labelText = typeof label === 'string' ? label : undefined;
  return (
    <a
      ref={ref}
      title={title ?? labelText}
      aria-label={rest['aria-label'] ?? labelText}
      className={buttonClass({
        variant,
        size,
        labelled: label !== undefined && short === undefined,
        className,
      })}
      {...rest}
    >
      <Content label={label} short={short}>
        {children}
      </Content>
    </a>
  );
}

/** Ссылка роутера в виде кнопки: те же to, params, search, что у Link, с проверкой типов. */
export const ButtonLink = createLink(ButtonA);

/** Обычная ссылка в виде кнопки; target задаёт вызов (tg:// - не в новой вкладке). */
export function ButtonAnchor({
  variant,
  size,
  label,
  short,
  className,
  children,
  title,
  ...rest
}: Look & AnchorHTMLAttributes<HTMLAnchorElement>) {
  const labelText = typeof label === 'string' ? label : undefined;
  return (
    <a
      title={title ?? labelText}
      aria-label={rest['aria-label'] ?? labelText}
      className={buttonClass({
        variant,
        size,
        labelled: label !== undefined && short === undefined,
        className,
      })}
      {...rest}
    >
      <Content label={label} short={short}>
        {children}
      </Content>
    </a>
  );
}
