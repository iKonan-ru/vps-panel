import { MobileActions } from '@/components/mobile-actions';
import { Button, ButtonLink } from '@/components/ui/button';
import { Menu, type MenuItem } from '@/components/ui/menu';
import { useFit } from '@/lib/use-fit';
import type { LinkProps } from '@tanstack/react-router';
import { type LucideIcon, Plus } from 'lucide-react';
import type { ReactNode } from 'react';

/** Прочее действие страницы: кнопка на широком экране, пункт меню "Ещё" на узком. */
export interface PageAction {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string | undefined;
}

/**
 * Действия страницы-списка (серверы, клиенты) - одинаково на всех таких страницах. Широкий экран:
 * в шапке страницы поиск или фильтры (переключатель блока под шапкой), "Добавить" и прочие
 * кнопки; прочие, что не поместились в ширину, - в меню "Ещё" в конце ряда. Узкий: те же поиск и "Добавить" - значками в верхней плашке, прочее - в её меню.
 */
export function PageActions({
  find,
  add,
  more = [],
}: {
  /** Переключатель блока поиска или фильтров; marked - фильтр включён, а блок закрыт. */
  find?: {
    label: string;
    icon: LucideIcon;
    open: boolean;
    marked?: boolean;
    onToggle: () => void;
  };
  /** Добавление: переход на страницу (to) или окно (onClick). */
  add: { label: string; to: NonNullable<LinkProps['to']> } | { label: string; onClick: () => void };
  more?: PageAction[];
}) {
  const iconCls = (narrow: boolean) => (narrow ? 'size-4' : 'size-3.5');
  const findButton = (narrow: boolean) =>
    find && (
      <Button
        size={narrow ? 'icon' : 'sm'}
        variant={find.open ? 'primary' : narrow ? 'ghost' : 'default'}
        aria-expanded={find.open}
        aria-label={find.label}
        title={find.label}
        className="relative"
        onClick={find.onToggle}
      >
        <find.icon className={iconCls(narrow)} />
        {!narrow && find.label}
        {!find.open && find.marked && (
          <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-accent ring-2 ring-bg" />
        )}
      </Button>
    );
  const addButton = (narrow: boolean) => {
    const icon = <Plus className={iconCls(narrow)} />;
    const common = {
      size: narrow ? ('icon' as const) : ('sm' as const),
      variant: 'primary' as const,
      'aria-label': add.label,
      title: add.label,
    };
    return 'to' in add ? (
      <ButtonLink to={add.to} {...common}>
        {icon}
        {!narrow && add.label}
      </ButtonLink>
    ) : (
      <Button {...common} onClick={add.onClick}>
        {icon}
        {!narrow && add.label}
      </Button>
    );
  };
  const items: MenuItem[] = more.map((a) => ({
    key: a.key,
    label: a.label,
    icon: a.icon,
    onSelect: a.onClick,
    ...(a.disabled !== undefined ? { disabled: a.disabled } : {}),
    title: a.title,
  }));
  // поиск и "Добавить" - в ряду всегда; кнопка меню (h-7.5) и отступ gap-2
  const fixed = (find ? 1 : 0) + 1;
  const { row, measure, fit, full } = useFit(fixed + more.length, 30 + 8, fixed);
  const moreButton = (a: PageAction) => (
    <Button
      key={a.key}
      size="sm"
      disabled={a.disabled}
      title={a.title ?? a.label}
      onClick={a.onClick}
    >
      {a.icon}
      {a.label}
    </Button>
  );
  return (
    <>
      {/* не шире строки шапки: переносится на свою строку, лишнее уходит в меню */}
      <div
        ref={row}
        style={full !== undefined ? { width: full } : undefined}
        className="relative flex min-w-0 max-w-full items-center gap-2 max-md:hidden"
      >
        {findButton(false)}
        {addButton(false)}
        {more.slice(0, fit - fixed).map(moreButton)}
        {fit - fixed < more.length && <Menu items={items.slice(fit - fixed)} />}
        {/* невидимая копия ряда целиком: по ней видно, сколько кнопок помещается */}
        <div
          aria-hidden="true"
          inert
          className="pointer-events-none invisible absolute top-0 left-0 h-0 w-0 overflow-hidden"
        >
          <div ref={measure} className="flex w-max items-center gap-2">
            {find && (
              <span data-fit className="flex">
                {findButton(false)}
              </span>
            )}
            <span data-fit className="flex">
              {addButton(false)}
            </span>
            {more.map((a) => (
              <span key={a.key} data-fit className="flex">
                {moreButton(a)}
              </span>
            ))}
          </div>
        </div>
      </div>
      <MobileActions>
        {findButton(true)}
        {addButton(true)}
        {items.length > 0 && <Menu items={items} size="md" variant="ghost" />}
      </MobileActions>
    </>
  );
}
