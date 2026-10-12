import { MOBILE_CRUMBS_ID } from '@/components/breadcrumbs';
import { DeployBanner, usePanelVersion } from '@/components/deploy-banner';
import { Logo } from '@/components/logo';
import { MOBILE_ACTIONS_ID } from '@/components/mobile-actions';
import { TelegramBanner } from '@/components/telegram-banner';
import { Button } from '@/components/ui/button';
import { BottomSheet } from '@/components/ui/sheet';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useLiveUpdates } from '@/lib/live';
import { toggleTheme } from '@/lib/theme';
import { useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useLocation, useNavigate } from '@tanstack/react-router';
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

/** more - на мобиле не в полосе вкладок (там тесно), а в панели "Ещё". */
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

/**
 * Каркас: на широком экране боковое меню, сворачиваемое до полосы с иконками (запоминается);
 * на узком - полоса вкладок внизу экрана, без выезжающего меню.
 */
export function AppLayout({ login }: { login: string }) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [more, setMore] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const pathname = useLocation({ select: (l) => l.pathname });
  const version = usePanelVersion();
  // живые события панели - одна подписка на всё приложение
  useLiveUpdates();

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
          'hidden h-full shrink-0 flex-col gap-1.5 border-r border-border bg-surface transition-[width] duration-150 md:flex',
          collapsed ? 'w-[64px] p-2.5' : 'w-[232px] p-3.5',
        )}
      >
        {/* в свёрнутом меню знак - размером с пункт меню (h-9.5) и по центру полосы */}
        <div className={cn('pt-1 pb-5', collapsed ? 'flex justify-center' : 'px-2')}>
          <Link to="/" aria-label="На главную" className="inline-flex">
            <Logo compact={collapsed} size={collapsed ? 38 : 28} />
          </Link>
        </div>
        {nav.map((n) => (
          <Link
            key={n.to}
            to={n.to}
            title={collapsed ? n.label : undefined}
            className={cn(
              'flex h-9.5 items-center gap-2.5 rounded-lg text-sm hover:bg-surface-2 hover:text-text',
              collapsed ? 'justify-center px-0' : 'px-2.5',
              isActive(n.to, pathname) ? 'bg-surface-2 text-text' : 'text-muted',
            )}
          >
            {n.icon}
            {!collapsed && <span>{n.label}</span>}
          </Link>
        ))}
        <div className="grow" />
        {/* учётка, тема, выход */}
        <div
          className={cn(
            'flex items-center gap-2 rounded-lg border-t border-border pt-2.5',
            collapsed ? 'flex-col' : '',
          )}
        >
          <div
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-surface-2 text-[13px] font-semibold uppercase"
            title={login}
          >
            {login.slice(0, 2)}
          </div>
          {!collapsed && (
            <div className="min-w-0 grow">
              <div className="truncate text-sm">{login}</div>
              <div className="truncate text-[11px] text-muted" title="Адрес и версия панели">
                {location.hostname}
                {version && `, ${version}`}
              </div>
            </div>
          )}
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Тёмная или светлая тема"
            title="Тёмная или светлая тема"
            onClick={() => toggleTheme()}
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
        {/* Верхняя плашка на мобиле: слева лого и хлебные крошки (портал Breadcrumbs), справа кнопки страницы (портал MobileActions) */}
        {/* высота - 56px плюс вырез сверху (PWA на iPhone): иначе отступ съедает высоту плашки */}
        <header className="fixed inset-x-0 top-0 z-20 flex h-[calc(56px+env(safe-area-inset-top))] items-center gap-2 border-b border-border bg-surface px-4 pt-[env(safe-area-inset-top)] md:hidden">
          <Link to="/" aria-label="На главную" className="inline-flex">
            <Logo size={26} />
          </Link>
          <div id={MOBILE_CRUMBS_ID} className="flex min-w-0 grow items-center" />
          <div id={MOBILE_ACTIONS_ID} className="flex items-center gap-1.5" />
        </header>
        {/* сверху и снизу запас под плашку и полосу вкладок на мобиле; прокручивается этот блок,
            а не окно - его прокрутку сбрасывает и восстанавливает роутер (router.tsx) */}
        <div
          id={APP_SCROLL_ID}
          data-scroll-restoration-id={APP_SCROLL_ID}
          className="flex flex-col gap-5 overflow-auto p-4 pt-[calc(56px+env(safe-area-inset-top)+16px)] pb-[calc(72px+env(safe-area-inset-bottom))] md:p-7 [&>*]:shrink-0"
        >
          <DeployBanner />
          <TelegramBanner />
          <Outlet />
        </div>
      </main>

      {/* Полоса вкладок внизу экрана: только на узком экране */}
      <nav
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
        aria-label="Разделы"
      >
        {nav
          .filter((n) => !n.more)
          .map((n) => (
            <Link
              key={n.to}
              to={n.to}
              onClick={() => setMore(false)}
              className={cn(
                'relative flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px]',
                isActive(n.to, pathname) && !more
                  ? 'font-medium text-accent before:absolute before:inset-x-5 before:top-0 before:h-0.5 before:rounded-full before:bg-accent'
                  : 'text-muted',
              )}
            >
              {n.icon}
              <span>{n.label}</span>
            </Link>
          ))}
        <button
          type="button"
          aria-expanded={more}
          className={cn(
            'relative flex h-14 flex-1 flex-col items-center justify-center gap-1 text-[11px]',
            more || nav.some((n) => n.more && isActive(n.to, pathname))
              ? 'font-medium text-accent before:absolute before:inset-x-5 before:top-0 before:h-0.5 before:rounded-full before:bg-accent'
              : 'text-muted',
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
          <div className="flex size-10 shrink-0 items-center justify-center rounded-full bg-surface-2 text-sm font-semibold uppercase">
            {login.slice(0, 2)}
          </div>
          <div className="min-w-0 grow">
            <div className="truncate text-sm">{login}</div>
            <div className="truncate text-xs text-muted">
              {location.hostname}, панель {version ?? '?'}
            </div>
          </div>
          <Button
            size="icon"
            variant="ghost"
            aria-label="Тёмная или светлая тема"
            title="Тёмная или светлая тема"
            onClick={() => toggleTheme()}
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
