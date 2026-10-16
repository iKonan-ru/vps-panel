import { Chip } from '@/components/ui/chip';
import { isSafeHref } from '@/lib/safe-url';
import { type Service, serviceByKind } from '@vps/protocol';
import { ExternalLink } from 'lucide-react';

/** Плашки сервисов вне каталога панели. */
const other: Record<string, string> = { wireguard: 'WG', 'wg-easy': 'wg-easy', custom: '' };

/** Плашки сервисов; у тех, где есть панель, плашка - ссылка. */
export function ServiceChips({
  services,
  max,
  links = {},
}: {
  services: Service[];
  max?: number;
  /** Вход в панели через поддомены (ServerSummary.panelLinks). */
  links?: Record<string, string>;
}) {
  if (services.length === 0) return <span className="text-muted">нет</span>;
  const shown = max ? services.slice(0, max) : services;
  const seen = new Set<string>();
  return (
    <div className="flex flex-wrap gap-1.5">
      {shown.map((s, i) => {
        const label =
          s.kind === 'amnezia' ? s.title : serviceByKind(s.kind)?.short || other[s.kind] || s.title;
        const key = `${s.kind}:${label}:${i}`;
        if (s.kind !== 'amnezia' && seen.has(s.kind)) return null;
        seen.add(s.kind);
        const href = links[s.kind] ?? s.panelUrl;
        // сервис упал: красная плашка, причина - в подсказке
        const down = s.details?.down === true;
        const tone = down ? 'bad' : 'accent';
        const why =
          down && typeof s.details?.downReason === 'string' ? `: ${s.details.downReason}` : '';
        return isSafeHref(href) ? (
          <a
            key={key}
            href={href}
            target="_blank"
            rel="noreferrer"
            title={down ? `${label} не работает${why}` : `Открыть панель ${label}`}
          >
            <Chip tone={tone}>
              {label}
              <ExternalLink className="size-2.5" />
            </Chip>
          </a>
        ) : (
          <Chip key={key} tone={tone} title={down ? `${label} не работает${why}` : undefined}>
            {label}
          </Chip>
        );
      })}
      {max && services.length > max && <Chip>+{services.length - max}</Chip>}
    </div>
  );
}
