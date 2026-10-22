import { z } from 'zod';

/**
 * Палитра тегов серверов: ключи цветов, сами цвета - в теме интерфейса (--tag-<ключ>, светлая и
 * тёмная). Порядок - порядок выдачи: соседние цвета заметно различаются.
 */
export const TAG_COLORS = [
  'sky',
  'orange',
  'teal',
  'rose',
  'violet',
  'amber',
  'green',
  'pink',
  'indigo',
  'slate',
] as const;
export const TagColorSchema = z.enum(TAG_COLORS);
export type TagColor = z.infer<typeof TagColorSchema>;

/** Самый длинный тег. */
export const TAG_MAX = 32;

/** Тег из справочника: имя, цвет и на скольких серверах стоит. */
export const TagSchema = z.object({
  name: z.string(),
  color: TagColorSchema,
  servers: z.number().int(),
});
export type Tag = z.infer<typeof TagSchema>;

/** Имя тега: без пробелов по краям и повторных пробелов внутри, не длиннее TAG_MAX. */
export function normTag(s: string): string {
  return s.trim().replace(/\s+/g, ' ').slice(0, TAG_MAX).trim();
}

/** Цвет нового тега: первый свободный по порядку палитры, заняты все - самый редкий. */
export function nextTagColor(used: readonly string[]): TagColor {
  const count = new Map<string, number>();
  for (const c of used) count.set(c, (count.get(c) ?? 0) + 1);
  let best: TagColor = TAG_COLORS[0];
  for (const c of TAG_COLORS) {
    if ((count.get(c) ?? 0) < (count.get(best) ?? 0)) best = c;
  }
  return best;
}
