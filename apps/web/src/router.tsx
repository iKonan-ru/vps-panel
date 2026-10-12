import { APP_SCROLL_ID, AppLayout } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useMe, useSetupStatus } from '@/lib/auth';
import { LoginPage, NoAdminPage } from '@/pages/login';
import { ServersPage } from '@/pages/servers';
import {
  Navigate,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';

// Страницы, кроме входа и списка серверов, грузятся по первому заходу: одна сборка весила
// 1.1 МБ (xterm, QR, все страницы) и целиком качалась на телефоне до первого экрана.

const AppsPage = lazyRouteComponent(() => import('@/pages/apps'), 'AppsPage');
const ClientPage = lazyRouteComponent(() => import('@/pages/client'), 'ClientPage');
const ClientServerPage = lazyRouteComponent(
  () => import('@/pages/client-server'),
  'ClientServerPage',
);
const ClientsPage = lazyRouteComponent(() => import('@/pages/clients'), 'ClientsPage');
const CommandRunPage = lazyRouteComponent(() => import('@/pages/command-run'), 'CommandRunPage');
const CommandsPage = lazyRouteComponent(() => import('@/pages/commands'), 'CommandsPage');
const OpenPanelPage = lazyRouteComponent(() => import('@/pages/open-panel'), 'OpenPanelPage');
const LogPage = lazyRouteComponent(() => import('@/pages/log'), 'LogPage');
const ServerPage = lazyRouteComponent(() => import('@/pages/server'), 'ServerPage');
const ServerNewPage = lazyRouteComponent(() => import('@/pages/server-new'), 'ServerNewPage');
const ServicesPage = lazyRouteComponent(() => import('@/pages/services'), 'ServicesPage');
const SettingsPage = lazyRouteComponent(() => import('@/pages/settings'), 'SettingsPage');
const AccountPage = lazyRouteComponent(() => import('@/pages/account'), 'AccountPage');

function Root() {
  return <Outlet />;
}

/** Корень: без администратора или сессии - страница входа, иначе приложение. */
function Gate() {
  const setup = useSetupStatus();
  const me = useMe();
  if (setup.isLoading || me.isLoading) return <div className="p-8 text-muted">Загрузка...</div>;
  // панель не ответила (502 во время выкладки) - это не "не вошёл": на вход не уводим
  if (me.error)
    return (
      <div className="flex flex-col items-start gap-3 p-8">
        <div className="text-bad">Панель не отвечает: {me.error.message}</div>
        <Button size="sm" onClick={() => void me.refetch()}>
          Повторить
        </Button>
      </div>
    );
  if (!me.data || (setup.data && !setup.data.setupDone)) return <Navigate to="/login" />;
  return <AppLayout login={me.data.login} />;
}

const rootRoute = createRootRoute({ component: Root });
/** Одна страница входа: без администратора - как его создать из консоли. */
function Entry() {
  const setup = useSetupStatus();
  const me = useMe();
  if (setup.isLoading || me.isLoading) return <div className="p-8 text-muted">Загрузка...</div>;
  if (me.data) return <Navigate to="/" />;
  if (setup.data && !setup.data.setupDone) return <NoAdminPage />;
  return <LoginPage />;
}

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/login',
  component: Entry,
});
/**
 * "Открываю панель" сервиса: проверка канала до панели на сервере перед переходом на поддомен.
 * Без каркаса (открывается в новой вкладке); без сессии сама уводит на вход с возвратом.
 */
const openPanelRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/open/$label',
  component: OpenPanelPage,
});
/** Старый адрес мастера - на общую страницу входа. */
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: Gate });
const serversRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/',
  component: ServersPage,
});
const newServerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers/new',
  component: ServerNewPage,
});
const serverRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers/$id',
  component: ServerPage,
});
/** Вкладка карточки в адресе: /servers/<id>/firewall, /servers/<id>/docker и т.д. */
const serverTabRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/servers/$id/$tab',
  component: ServerPage,
});
const commandsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/commands',
  component: CommandsPage,
});
const commandRunRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/commands/$id',
  validateSearch: (raw: Record<string, unknown>) => ({
    server: typeof raw.server === 'string' ? raw.server : undefined,
    run: typeof raw.run === 'string' ? raw.run : undefined,
    tab:
      raw.tab === 'form' || raw.tab === 'output' || raw.tab === 'history'
        ? (raw.tab as 'form' | 'output' | 'history')
        : undefined,
  }),
  component: CommandRunPage,
});
const logRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/log',
  component: LogPage,
});
const clientsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/clients',
  component: ClientsPage,
});
const clientRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/clients/$id',
  component: ClientPage,
});
/** Клиент на одном сервере: живая статистика по сервисам. */
const clientServerRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/clients/$id/servers/$serverId',
  component: ClientServerPage,
});
const servicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/services',
  component: ServicesPage,
});
const appsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/apps',
  component: AppsPage,
});
const settingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/settings',
  component: SettingsPage,
});
const accountRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/account',
  component: AccountPage,
});

const routeTree = rootRoute.addChildren([
  loginRoute,
  openPanelRoute,
  appRoute.addChildren([
    serversRoute,
    newServerRoute,
    serverRoute,
    serverTabRoute,
    commandsRoute,
    commandRunRoute,
    logRoute,
    servicesRoute,
    clientsRoute,
    clientRoute,
    clientServerRoute,
    appsRoute,
    settingsRoute,
    accountRoute,
  ]),
]);

/**
 * Прокрутка: новый переход - страница сверху, "Назад" и "Вперёд" - туда, где был (позиция
 * запоминается на запись истории). Прокручивается не окно, а блок страницы в каркасе
 * (APP_SCROLL_ID): без сброса список серверов открывался на высоте, до которой пролистали
 * карточку сервера.
 */
export const router = createRouter({
  routeTree,
  scrollRestoration: true,
  scrollToTopSelectors: ['window', `#${APP_SCROLL_ID}`],
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
