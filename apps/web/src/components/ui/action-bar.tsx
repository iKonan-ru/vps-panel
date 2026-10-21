import { MobileActions } from '@/components/mobile-actions';
import { Button } from '@/components/ui/button';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { cn } from '@/lib/cn';
import { useFit } from '@/lib/use-fit';
import { Fragment, type ReactNode } from 'react';

/**
 * Действие: onClick - кнопка, href - ссылка наружу, node - свой элемент вместо кнопки (в меню пункт
 * всё равно ведёт на onClick или href).
 */
interface BarAction {
  key: string;
  /** Полная подпись: кнопка на широком экране, пункт меню. */
  label: string;
  /** Подпись кнопки на узком экране, по умолчанию - label. */
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
  /** Группы разделены отступом и переносятся целиком, в меню - чертой. */
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

/** Пункты меню "Ещё": между группами - черта. */
function menuItems(list: BarAction[]): MenuItem[] {
  return list.map((a, i) => ({
    key: a.key,
    label: a.label,
    icon: a.icon,
    ...(a.onClick ? { onSelect: a.onClick } : {}),
    ...(a.href ? { href: a.href } : {}),
    disabled: a.disabled || (!a.onClick && !a.href),
    title: a.title,
    danger: a.variant === 'danger',
    separator: i > 0 && a.group !== list[i - 1]?.group,
  }));
}

/** Кнопка меню "Ещё" и отступ перед ней (gap-x-5): место, которое она занимает в ряду. */
const MENU_RESERVE = { sm: 30 + 20, md: 36 + 20 };

/**
 * Панель действий: широкий экран - кнопки по группам, а что не поместилось в ширину - в меню "Ещё"
 * в конце ряда; узкий - главные (mobile) и меню "Ещё".
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
  /** Всегда справа (обновить данные). */
  end?: ReactNode;
  size?: 'sm' | 'md';
  /** Строка списка: на широком экране второстепенные действия - значками, главные - с подписью. */
  dense?: boolean;
  /** Меню "Ещё" на узком экране - в верхней плашке, а не отдельной строкой в шапке страницы. */
  topbar?: boolean;
  className?: string;
}) {
  const shown = actions.filter((a) => !a.hidden);
  // два действия и меньше помещаются и на узком экране: меню ради одного пункта не нужно
  const few = shown.length <= 2;
  const mobile = shown.filter((a) => few || a.mobile);
  const rest = shown.filter((a) => !few && !a.mobile);
  const items = menuItems(rest);
  // строка списка (dense) - значками и с переносом, как раньше; иначе - сколько поместится
  const { row, measure, fit, full } = useFit(shown.length, MENU_RESERVE[size], 0, !dense);
  const overflow = menuItems(shown.slice(fit));
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
    // не сжимается: иначе в строке списка рядом с длинным текстом кнопки уезжали бы за край; но не
    // шире строки - в шапке страницы панель переносится на свою строку, лишнее уходит в меню
    <div
      className={cn(
        'flex max-w-full shrink-0 items-center gap-2',
        narrowEmpty && 'max-md:hidden',
        className,
      )}
    >
      {/* между группами - отступ, а не черта: черта на переносе оставалась бы в начале строки */}
      <div
        ref={row}
        style={full !== undefined ? { width: full } : undefined}
        className={cn(
          'relative hidden min-w-0 items-center md:flex',
          dense ? 'flex-wrap gap-1' : 'gap-x-5',
        )}
      >
        {groups(shown.slice(0, fit)).map((g) => (
          <div key={g[0]?.key} className={cn('flex items-center', dense ? 'gap-1' : 'gap-2')}>
            {g.map((a) => (
              <Fragment key={a.key}>{dense && !a.mobile ? icon(a) : button(a, a.label)}</Fragment>
            ))}
          </div>
        ))}
        {overflow.length > 0 && <Menu items={overflow} size={size} />}
        {/* невидимая копия всего ряда в одну строку: по ней видно, сколько кнопок помещается */}
        {!dense && (
          <div
            aria-hidden="true"
            inert
            className="pointer-events-none invisible absolute top-0 left-0 h-0 w-0 overflow-hidden"
          >
            <div ref={measure} className="flex w-max items-center gap-x-5">
              {groups(shown).map((g) => (
                <div key={g[0]?.key} className="flex items-center gap-2">
                  {g.map((a) => (
                    <span key={a.key} data-fit className="flex">
                      {button(a, a.label)}
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
        )}
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
