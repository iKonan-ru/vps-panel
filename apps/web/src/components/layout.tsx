import { MOBILE_CRUMBS_ID } from '@/components/breadcrumbs';
import { SyncBanner } from '@/components/clients/sync-banner';
import { DeployBanner, usePanelVersion } from '@/components/deploy-banner';
import { Logo } from '@/components/logo';
import { MOBILE_ACTIONS_ID } from '@/components/mobile-actions';
import { PanelVersionBadge } from '@/components/panel-version-badge';
import { TelegramBanner } from '@/components/telegram-banner';
import { Button } from '@/components/ui/button';
import { BottomSheet } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useLiveUpdates } from '@/lib/live';
import { toggleTheme } from '@/lib/theme';
import { useSlider } from '@/lib/use-slider';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate, useRouterState } from '@tanstack/react-router';
import {
  FileText,
  LayoutGrid,
  LogOut,
  Moon,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Server,
  Settings,
  Smartphone,
  SunMoon,
  Terminal,
  Users,
} from 'lucide-react';
import { type ReactNode, useState } from 'react';

/** Блок, который прокручивается вместо окна. */
export const APP_SCROLL_ID = 'app-scroll';

/** more - на узком экране в панели "Ещё", а не в полосе вкладок (там тесно). */
const nav: { to: string; label: string; icon: ReactNode; more?: boolean }[] = [
  { to: '/', label: 'Серверы', icon: <Server className="size-4" /> },
  { to: '/services', label: 'Сервисы', icon: <LayoutGrid className="size-4" /> },
  { to: '/clients', label: 'Клиенты', icon: <Users className="size-4" /> },
  { to: '/commands', label: 'Команды', icon: <Terminal className="size-4" />, more: true },
  { to: '/log', label: 'Журнал', icon: <FileText className="size-4" />, more: true },
  { to: '/apps', label: 'Приложения', icon: <Smartphone className="size-4" />, more: true },
  { to: '/settings', label: 'Настройки', icon: <Settings className="size-4" /> },
];

const COLLAPSED_KEY = 'vps-sidebar-collapsed';

/** Раздел активен и на вложенных страницах: карточка сервера относится к "Серверам". */
function isActive(to: string, pathname: string): boolean {
  if (to === '/') return pathname === '/' || pathname.startsWith('/servers');
  return pathname === to || pathname.startsWith(`${to}/`);
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) === '1';
  } catch {
    return false;
  }
}

/** Две буквы для кружка аккаунта: инициалы имени из двух слов, иначе начало имени. */
function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return words.length > 1 ? `${words[0]?.[0] ?? ''}${words[1]?.[0] ?? ''}` : name.slice(0, 2);
}

/**
 * Каркас: на широком экране боковое меню (сворачивается), на узком - полоса вкладок внизу. name -
 * имя в интерфейсе (или логин, если имя не задано).
 */
export function AppLayout({ login, name }: { login: string; name: string }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [more, setMore] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  // страница, которая уже на экране: пока грузится код новой, роутер держит старую, а адрес уже
  // новый - проявление по адресу перемонтировало бы старую страницу (мерцание при первом переходе)
  const shownPath = useRouterState({ select: (s) => (s.resolvedLocation ?? s.location).pathname });
  const version = usePanelVersion();
  // живые события панели - одна подписка на всё приложение
  useLiveUpdates();
  // подсветка раздела в меню и полоса в полосе вкладок переезжают к выбранному пункту
  const side = useSlider<HTMLDivElement>([pathname, collapsed]);
  const moreActive = more || nav.some((n) => n.more && isActive(n.to, pathname));
  const bottom = useSlider<HTMLElement>([pathname, more]);

  function toggleCollapsed() {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0');
    } catch {}
  }

  async function logout() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // сессия уже истекла или отозвана - выходить не из чего, на вход всё равно
    }
    qc.setQueryData(['me'], null);
    await navigate({ to: '/login' });
  }

  return (
    <div className="flex h-full">
      <aside
        className={cn(
          'glass hidden h-full shrink-0 flex-col gap-1.5 border-r transition-[width] duration-150 md:flex',
          collapsed ? 'w-[64px] p-2.5' : 'w-[232px] p-3.5',
        )}
      >
        {/* в свёрнутом меню знак - размером с пункт меню (h-9.5) и по центру полосы */}
        <div
          className={cn(
            'pt-1 pb-5',
            collapsed ? 'flex flex-col items-center gap-1.5' : 'flex items-center px-2',
          )}
        >
          {collapsed ? (
            <>
              <Link to="/" aria-label="На главную" className="inline-flex">
                <Logo compact size={38} />
              </Link>
              <PanelVersionBadge compact />
            </>
          ) : (
            // плашка - под названием: версия вида 1.0.0-beta.13 в строку с ним не помещается
            <div className="flex items-center gap-2.5">
              <Link to="/" aria-label="На главную" className="inline-flex">
                <Logo compact size={32} />
              </Link>
              <div className="flex min-w-0 flex-col items-start gap-0.5">
                <Link
                  to="/"
                  className="logo-text whitespace-nowrap font-semibold leading-tight"
                  tabIndex={-1}
                >
                  VPS Panel
                </Link>
                <PanelVersionBadge />
              </div>
            </div>
          )}
        </div>
        <div ref={side.box} className="relative flex flex-col gap-1.5">
          {/* подсветка выбранного раздела - одна на меню, переезжает к нему */}
          {side.rect && (
            <span
              aria-hidden="true"
              className={cn(
                'gloss-button pointer-events-none absolute inset-x-0 rounded-lg border border-border bg-surface-2',
                side.rect.animate && 'transition-[top,height] duration-300 ease-out',
              )}
              style={{ top: side.rect.top, height: side.rect.height }}
            />
          )}
          {nav.map((n) => {
            const active = isActive(n.to, pathname);
            return (
              <Link
                key={n.to}
                to={n.to}
                title={collapsed ? n.label : undefined}
                data-active={active}
                className={cn(
                  'relative flex h-9.5 items-center gap-2.5 rounded-lg border border-transparent text-sm transition-colors duration-200',
                  '[&>svg]:transition-transform [&>svg]:duration-200 hover:[&>svg]:scale-110',
                  collapsed ? 'justify-center px-0' : 'px-2.5',
                  active
                    ? 'text-text [&>svg]:text-accent'
                    : 'text-muted hover:bg-surface-2/60 hover:text-text',
                )}
              >
                {n.icon}
                {!collapsed && <span className="animate-fade-in">{n.label}</span>}
              </Link>
            );
          })}
        </div>
        <div className="grow" />
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border-t border-[var(--glass-border)] pt-2.5',
            collapsed ? 'flex-col' : '',
          )}
        >
          <Link
            to="/account"
            className="gloss-button flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-semibold uppercase hover:ring-1 hover:ring-accent"
            title={`${name === login ? login : `${name} (${login})`}: аккаунт`}
            aria-label="Аккаунт"
          >
            {initials(name)}
          </Link>
          {!collapsed && (
            <div className="min-w-0 grow">
              <Link
                to="/account"
                className="block truncate text-sm hover:text-accent"
                title="Аккаунт"
              >
                {name}
              </Link>
              <div className="truncate text-[11px] text-muted" title="Адрес панели">
                {location.hostname}
              </div>
            </div>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Тёмная или светлая тема"
            title="Тёмная или светлая тема"
            onClick={() => toggleTheme()}
            className="[&>svg]:transition-transform [&>svg]:duration-300 hover:[&>svg]:-rotate-20"
          >
            <Moon className="size-4" />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Выйти" title="Выйти" onClick={logout}>
            <LogOut className="size-4" />
          </Button>
        </div>
        <Button
          variant="ghost"
          size={collapsed ? 'icon' : 'sm'}
          className={cn('mt-1', collapsed ? 'mx-auto' : 'justify-start')}
          aria-label={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
          title={collapsed ? 'Развернуть меню' : 'Свернуть меню'}
          onClick={toggleCollapsed}
        >
          {collapsed ? (
            <PanelLeftOpen className="size-4" />
          ) : (
            <>
              <PanelLeftClose className="size-4" />
              Свернуть
            </>
          )}
        </Button>
      </aside>

      <main className="flex min-w-0 grow flex-col">
        {/* в верхнюю плашку на узком экране - порталы Breadcrumbs и MobileActions */}
        {/* высота - 56px плюс вырез сверху (PWA на iPhone): иначе отступ съедает высоту плашки */}
        <header className="fixed inset-x-0 top-0 z-20 flex h-[calc(56px+env(safe-area-inset-top))] items-center gap-2 border-b glass px-4 pt-[env(safe-area-inset-top)] md:hidden">
          <Link to="/" aria-label="На главную" className="inline-flex">
            <Logo size={26} />
          </Link>
          <PanelVersionBadge compact />
          <div id={MOBILE_CRUMBS_ID} className="flex min-w-0 grow items-center" />
          <div id={MOBILE_ACTIONS_ID} className="flex items-center gap-1.5" />
        </header>
        {/* сверху и снизу запас под плашку и полосу вкладок; прокручивается этот блок, а не
            окно - его прокрутку сбрасывает и восстанавливает роутер */}
        <div
          id={APP_SCROLL_ID}
          data-scroll-restoration-id={APP_SCROLL_ID}
          className="flex flex-col gap-5 overflow-auto p-4 pt-[calc(56px+env(safe-area-inset-top)+16px)] pb-[calc(72px+env(safe-area-inset-bottom))] md:p-7 [&>*]:shrink-0"
        >
          <DeployBanner />
          <SyncBanner />
          <TelegramBanner />
          {/* новая страница проявляется (только прозрачность: transform сломал бы fixed внутри) */}
          <div
            key={shownPath}
            className="flex min-w-0 animate-fade-in flex-col gap-5 [&>*]:shrink-0"
          >
            <Outlet />
          </div>
        </div>
      </main>

      <nav
        ref={bottom.box}
        className="glass fixed inset-x-0 bottom-0 z-20 flex border-t pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Разделы"
      >
        {/* полоса над выбранным разделом - переезжает к нему */}
        {bottom.rect && (
          <span
            aria-hidden="true"
            className={cn(
              'pointer-events-none absolute top-0 h-0.5 rounded-full bg-accent shadow-[0_0_8px_var(--accent)]',
              bottom.rect.animate && 'transition-[left,width] duration-300 ease-out',
            )}
            style={{ left: bottom.rect.left + 20, width: bottom.rect.width - 40 }}
          />
        )}
        {nav
          .filter((n) => !n.more)
          .map((n) => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setMore(false)}
              data-active={isActive(n.to, pathname) && !more}
              className={cn(
                'relative flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] transition-colors duration-200',
                '[&>svg]:transition-transform [&>svg]:duration-150 active:[&>svg]:scale-90',
                isActive(n.to, pathname) && !more ? 'font-medium text-accent' : 'text-muted',
              )}
            >
              {n.icon}
              <span>{n.label}</span>
            </Link>
          ))}
        <button
          type="button"
          aria-expanded={more}
          data-active={moreActive}
          className={cn(
            'relative flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px] transition-colors duration-200',
            '[&>svg]:transition-transform [&>svg]:duration-150 active:[&>svg]:scale-90',
            moreActive ? 'font-medium text-accent' : 'text-muted',
          )}
          onClick={() => setMore(!more)}
        >
          <MoreHorizontal className="size-4" />
          <span>Ещё</span>
        </button>
      </nav>

      <BottomSheet open={more} onClose={() => setMore(false)} label="Ещё">
        {nav
          .filter((n) => n.more)
          .map((n) => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setMore(false)}
              className={cn(
                'mb-3 flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm',
                isActive(n.to, pathname) ? 'bg-surface-2 text-text' : 'text-muted',
              )}
            >
              {n.icon}
              {n.label}
            </Link>
          ))}
        <div className="flex items-center gap-3">
          <Link
            to="/account"
            onClick={() => setMore(false)}
            className="flex min-w-0 grow items-center gap-3"
            aria-label="Аккаунт"
          >
            <div className="gloss-button flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold uppercase">
              {initials(name)}
            </div>
            <div className="min-w-0 grow">
              <div className="truncate text-sm">{name}</div>
              <div className="truncate text-xs text-muted">
                {location.hostname}, панель {version ?? '?'}
              </div>
            </div>
          </Link>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Тёмная или светлая тема"
            title="Тёмная или светлая тема"
            onClick={() => toggleTheme()}
            className="[&>svg]:transition-transform [&>svg]:duration-300 active:[&>svg]:rotate-45"
          >
            <SunMoon className="size-4" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="text-bad hover:text-bad"
            aria-label="Выйти"
            title="Выйти"
            onClick={() => {
              setMore(false);
              void logout();
            }}
          >
            <LogOut className="size-4" />
          </Button>
        </div>
      </BottomSheet>
    </div>
  );
}
