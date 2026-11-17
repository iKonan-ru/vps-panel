import { cn } from '@/lib/cn';
import { countryName, flagOf } from '@/lib/countries';
import { useServers } from '@/lib/servers';
import type { Hosting } from '@vps/protocol';

type Origin = Pick<Hosting, 'country' | 'provider'> | null | undefined;

/** Флаг страны и хостинг одной строкой (флаг Нидерландов и "Hoster"); не указаны - пусто. */
export function serverOrigin(h: Origin): string {
  if (!h) return '';
  const flag = flagOf(h.country) || h.country;
  return [flag, h.provider].filter(Boolean).join(' ');
}

/**
 * Флаг страны и хостинг мелко рядом с именем сервера: по случайному имени сервер не узнать.
 * hosting - если сервер под рукой, иначе id - из списка серверов.
 */
export function ServerOrigin({
  hosting,
  id,
  className,
}: {
  hosting?: Origin;
  id?: string | null | undefined;
  className?: string;
}) {
  const { data } = useServers();
  const h = hosting ?? (id ? data?.find((s) => s.id === id)?.hosting : undefined);
  const text = serverOrigin(h);
  if (!text) return null;
  return (
    <span
      className={cn('whitespace-nowrap text-xs font-normal text-muted', className)}
      title={[h?.country ? countryName(h.country) : '', h?.provider].filter(Boolean).join(', ')}
    >
      {text}
    </span>
  );
}

/** Подпись "имя, флаг и хостинг" для пунктов Select (в option разметки нет). */
export function useServerLabel(): (id: string, name: string) => string {
  const { data } = useServers();
  return (id, name) => {
    const o = serverOrigin(data?.find((s) => s.id === id)?.hosting);
    return o ? `${name} \u00b7 ${o}` : name;
  };
}
