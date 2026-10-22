import { TagChip } from '@/components/ui/tag-chip';
import { cn } from '@/lib/cn';
import { tagColorOf, tagKey, useTags } from '@/lib/tags';

/** Теги сервера плашками; onPick - плашки-кнопки (фильтр списка по тегу), active - выбранный. */
export function ServerTags({
  tags,
  onPick,
  active,
  className,
}: {
  tags: string[];
  onPick?: ((tag: string) => void) | undefined;
  active?: string | undefined;
  className?: string | undefined;
}) {
  const { data } = useTags();
  if (tags.length === 0) return null;
  const color = tagColorOf(data);
  return (
    <div className={cn('flex min-w-0 flex-wrap items-center gap-1', className)}>
      {tags.map((t) => (
        <TagChip
          key={t}
          name={t}
          color={color(t)}
          active={active !== undefined && tagKey(active) === tagKey(t)}
          onClick={onPick ? () => onPick(t) : undefined}
        />
      ))}
    </div>
  );
}
