import { Link } from '@tanstack/react-router';
import { Fragment, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

export const MOBILE_CRUMBS_ID = 'mobile-crumbs';

interface Crumb {
  label: string;
  /** Адрес раздела; у последнего звена (текущая страница) не указывается. */
  to?: string;
}

/** Хлебные крошки: на широком экране - над заголовком, на узком - порталом в верхнюю плашку. */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  const [el, setEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    setEl(document.getElementById(MOBILE_CRUMBS_ID));
  }, []);
  const trail = items.map((c, i) => (
    <Fragment key={`${c.label}-${i}`}>
      {i > 0 && <span className="shrink-0">/</span>}
      {c.to ? (
        <Link to={c.to} className="shrink-0 hover:text-text">
          {c.label}
        </Link>
      ) : (
        <span className="min-w-0 truncate text-text">{c.label}</span>
      )}
    </Fragment>
  ));
  return (
    <>
      <nav aria-label="Путь" className="hidden items-center gap-2 text-sm text-muted md:flex">
        {trail}
      </nav>
      {el &&
        createPortal(
          <nav aria-label="Путь" className="flex min-w-0 items-center gap-1.5 text-sm text-muted">
            {trail}
          </nav>,
          el,
        )}
    </>
  );
}
