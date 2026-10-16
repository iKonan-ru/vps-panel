import { MobileActions } from '@/components/mobile-actions';
import { Button } from '@/components/ui/button';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { Fragment, type ReactNode } from 'react';

/**
 * Действие панели. onClick - кнопка; href - ссылка наружу (в меню - новая вкладка); node -
 * свой элемент вместо кнопки (ссылка роутера, сдвоенная LinkButton) - он рисуется на широком
 * экране и среди видимых на узком, а в меню пункт ведёт на onClick или href.
 */
interface BarAction {
  key: string;
  /** Полная подпись: кнопка на широком экране, пункт меню. */
  label: string;
  /** Подпись видимой кнопки на узком экране (короче), по умолчанию - label. */
  short?: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
  node?: ReactNode;
  /** Свой элемент для узкого экрана (node с короткой подписью); нет - node или кнопка. */
  mobileNode?: ReactNode;
  variant?: 'default' | 'primary' | 'danger';
  disabled?: boolean;
  title?: string | undefined;
  /** На узком экране - кнопкой с подписью, а не в меню. Не больше двух на панель. */
  mobile?: boolean;
  /** Группа: на широком экране группы разделены отступом и переносятся целиком, в меню - чертой. */
  group?: string;
  /** Не показывать (условное действие без тернарников в разметке). */
  hidden?: boolean;
}

/** Подряд идущие действия одной группы. */
function groups(list: BarAction[]): BarAction[][] {
  const out: BarAction[][] = [];
  for (const a of list) {
    const last = out[out.length - 1];
    if (last && last[0]?.group === a.group) last.push(a);
    else out.push([a]);
  }
  return out;
}

/**
 * Панель действий - одна на всю панель (вкладки сервера, шапки страниц и блоков). На широком
 * экране - кнопки со значками и подписями, группы отдельно. На узком - главные действия
 * (mobile) кнопками с короткой подписью (short) и меню "Ещё" с остальными; действий два и меньше -
 * все кнопками. Подписи видны всегда, значков без слов нет. end - то, что стоит справа всегда
 * (обновить данные).
 */
export function ActionBar({
  actions,
  end,
  size = 'sm',
  dense,
  topbar,
  className,
}: {
  actions: BarAction[];
  end?: ReactNode;
  size?: 'sm' | 'md';
  /**
   * Действия строки списка: на широком экране второстепенные - значками с подсказкой (строк
   * много, место дорого), главные (mobile) - с подписью; узкий экран - как у обычной панели.
   */
  dense?: boolean;
  /**
   * Меню "Ещё" на узком экране - в верхней плашке (портал MobileActions), а не в странице:
   * для шапки страницы, где иначе меню стояло бы одно на отдельной строке.
   */
  topbar?: boolean;
  className?: string;
}) {
  const shown = actions.filter((a) => !a.hidden);
  // два действия и меньше помещаются и на узком экране: меню ради одного пункта не нужно
  const few = shown.length <= 2;
  const mobile = shown.filter((a) => few || a.mobile);
  const rest = shown.filter((a) => !few && !a.mobile);
  const items: MenuItem[] = rest.map((a, i) => ({
    key: a.key,
    label: a.label,
    icon: a.icon,
    ...(a.onClick ? { onSelect: a.onClick } : {}),
    ...(a.href ? { href: a.href } : {}),
    disabled: a.disabled || (!a.onClick && !a.href),
    title: a.title,
    danger: a.variant === 'danger',
    separator: i > 0 && a.group !== rest[i - 1]?.group,
  }));
  const icon = (a: BarAction) =>
    a.node ?? (
      <Button
        size="icon-sm"
        variant="ghost"
        disabled={a.disabled}
        title={a.title ? `${a.label}: ${a.title}` : a.label}
        aria-label={a.label}
        onClick={a.onClick}
        className={a.variant === 'danger' ? 'text-bad' : undefined}
      >
        {a.icon}
      </Button>
    );
  const button = (a: BarAction, text: string, narrow = false) =>
    (narrow ? (a.mobileNode ?? a.node) : a.node) ?? (
      <Button
        size={size}
        variant={a.variant ?? 'default'}
        disabled={a.disabled}
        title={a.title ?? a.label}
        onClick={a.onClick}
      >
        {a.icon}
        {text}
      </Button>
    );
  // на узком экране в странице ничего нет (всё в верхней плашке) - и пустой строки нет
  const narrowEmpty = mobile.length === 0 && (topbar || items.length === 0) && !end;
  return (
    // не сжимается: в строке списка рядом с длинным текстом кнопки иначе уезжали за край
    <div
      className={cn('flex shrink-0 items-center gap-2', narrowEmpty && 'max-md:hidden', className)}
    >
      {/* широкий экран: все кнопки с подписями; группа переносится целиком, между группами -
          отступ шире (черта на переносе оставалась бы в начале строки) */}
      <div
        className={cn(
          'hidden min-w-0 flex-wrap items-center md:flex',
          dense ? 'gap-1' : 'gap-x-5 gap-y-2',
        )}
      >
        {groups(shown).map((g) => (
          <div key={g[0]?.key} className={cn('flex items-center', dense ? 'gap-1' : 'gap-2')}>
            {g.map((a) => (
              <Fragment key={a.key}>{dense && !a.mobile ? icon(a) : button(a, a.label)}</Fragment>
            ))}
          </div>
        ))}
      </div>
      {/* узкий экран: главные с подписью и "Ещё" */}
      <div className="flex min-w-0 items-center gap-2 md:hidden">
        {mobile.map((a) => (
          <Fragment key={a.key}>{button(a, a.short ?? a.label, true)}</Fragment>
        ))}
        {items.length > 0 &&
          (topbar ? (
            <MobileActions>
              <Menu items={items} size="md" variant="ghost" />
            </MobileActions>
          ) : (
            <Menu items={items} size={size} />
          ))}
      </div>
      {end && (
        <>
          <div className="grow" />
          {end}
        </>
      )}
    </div>
  );
}
