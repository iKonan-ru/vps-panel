import { usePanelVersion } from '@/components/deploy-banner';
import { usePanelUpdate } from '@/components/panel-version-settings';
import { Chip } from '@/components/ui/chip';
import { Link } from '@tanstack/react-router';
import { ArrowUpCircle } from 'lucide-react';

/** Якорь блока "Версия панели" в настройках: туда ведёт плашка. */
export const PANEL_VERSION_ANCHOR = 'panel-version';

/**
 * Плашка версии у логотипа в меню: текущая версия; есть новая в канале - цветом обновления и
 * со стрелкой. Клик - настройки, блок "Версия панели" (там список изменений и кнопка).
 * compact - свёрнутое меню и мобильная шапка: только стрелка и только при обновлении.
 */
export function PanelVersionBadge({ compact = false }: { compact?: boolean }) {
  const { data } = usePanelUpdate();
  const running = usePanelVersion();
  const version = data?.current ?? running;
  const top = data?.newer[0];
  const title = top
    ? `Версия панели ${version ?? '?'}, доступна ${top.version}`
    : `Версия панели ${version ?? '?'}`;
  if (compact && !top) return null;
  if (!version && !top) return null;
  return (
    <Link
      to="/settings"
      hash={PANEL_VERSION_ANCHOR}
      title={title}
      aria-label={title}
      className="inline-flex shrink-0 rounded-full focus-visible:outline-2 focus-visible:outline-accent"
    >
      {compact ? (
        <ArrowUpCircle className="size-4.5 text-update" />
      ) : (
        <Chip
          tone={top ? 'update' : 'muted'}
          className="max-w-[150px] cursor-pointer gap-1 px-2 py-0 font-mono text-[11px] hover:brightness-125"
        >
          {top && <ArrowUpCircle className="size-3 shrink-0" />}
          <span className="truncate">{version ?? '?'}</span>
        </Chip>
      )}
    </Link>
  );
}
