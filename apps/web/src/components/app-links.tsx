import { LinkButton } from '@/components/ui/link-button';
import { type AppLink, type AppOs, useApps } from '@/lib/apps';
import { Link } from '@tanstack/react-router';

/** Ссылка на файл или магазин: кнопка-переход и копирование (ссылку можно переслать клиенту). */
export function AppLinkButton({ link }: { link: AppLink }) {
  const title = [link.version, link.note].filter(Boolean).join(', ');
  return (
    <LinkButton
      href={link.url}
      title={title || link.url}
      copyTitle={`Скопировать ссылку: ${link.label}`}
    >
      {link.label}
      {link.version && <span className="font-normal text-muted">{link.version}</span>}
    </LinkButton>
  );
}

/**
 * Где скачать приложение под устройство клиента (окна клиентов). ОС неизвестна (устройство не
 * указано или роутер) - ссылка на страницу "Приложения".
 */
export function AppLinks({ appId, os }: { appId: string; os: AppOs | null | undefined }) {
  const { data } = useApps();
  const app = data?.apps.find((a) => a.id === appId);
  if (!app) return null;
  const platform = os ? app.platforms.find((p) => p.os === os) : undefined;
  if (!platform)
    return (
      <div className="text-xs text-muted">
        Приложение {app.name} для любой ОС&nbsp;&mdash; на странице{' '}
        <Link to="/apps" className="text-accent hover:underline">
          &laquo;Приложения&raquo;
        </Link>
      </div>
    );
  return (
    <div className="flex w-full flex-col gap-1.5">
      <div className="text-xs text-muted">
        {app.name} для {platform.title}:
      </div>
      <div className="flex flex-wrap gap-2">
        {platform.links.map((l) => (
          <AppLinkButton key={l.url} link={l} />
        ))}
      </div>
    </div>
  );
}
