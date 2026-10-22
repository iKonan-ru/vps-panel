import { useQuery } from '@tanstack/react-query';
import { type Tag, type TagColor, nextTagColor } from '@vps/protocol';
import { api } from './api';

/** Справочник тегов серверов. */
export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: () => api<Tag[]>('/api/tags') });
}

/** Сравнение имён тегов - без учёта регистра, как в панели. */
export const tagKey = (s: string) => s.toLocaleLowerCase('ru');

/** Классы плашки тега по цвету - строками целиком, чтобы их нашёл Tailwind. */
export const TAG_TONE: Record<TagColor, string> = {
  sky: 'bg-tag-sky/15 text-tag-sky',
  orange: 'bg-tag-orange/15 text-tag-orange',
  teal: 'bg-tag-teal/15 text-tag-teal',
  rose: 'bg-tag-rose/15 text-tag-rose',
  violet: 'bg-tag-violet/15 text-tag-violet',
  amber: 'bg-tag-amber/15 text-tag-amber',
  green: 'bg-tag-green/15 text-tag-green',
  pink: 'bg-tag-pink/15 text-tag-pink',
  indigo: 'bg-tag-indigo/15 text-tag-indigo',
  slate: 'bg-tag-slate/15 text-tag-slate',
};

/** Заливка и цвет рамки образца цвета (выбор цвета тега). */
export const TAG_SWATCH: Record<TagColor, string> = {
  sky: 'bg-tag-sky ring-tag-sky',
  orange: 'bg-tag-orange ring-tag-orange',
  teal: 'bg-tag-teal ring-tag-teal',
  rose: 'bg-tag-rose ring-tag-rose',
  violet: 'bg-tag-violet ring-tag-violet',
  amber: 'bg-tag-amber ring-tag-amber',
  green: 'bg-tag-green ring-tag-green',
  pink: 'bg-tag-pink ring-tag-pink',
  indigo: 'bg-tag-indigo ring-tag-indigo',
  slate: 'bg-tag-slate ring-tag-slate',
};

/**
 * Цвет тега по имени: из справочника; новых имён (ещё не сохранены) - тот, что выдаст им панель
 * при сохранении в этом порядке.
 */
export function tagColorOf(tags: Tag[] | undefined, pending: readonly string[] = []) {
  const map = new Map((tags ?? []).map((t) => [tagKey(t.name), t.color]));
  const used: string[] = (tags ?? []).map((t) => t.color);
  for (const n of pending) {
    if (map.has(tagKey(n))) continue;
    const c = nextTagColor(used);
    used.push(c);
    map.set(tagKey(n), c);
  }
  return (name: string): TagColor => map.get(tagKey(name)) ?? 'slate';
}

/** Названия цветов для подсказок и чтения с экрана. */
export const TAG_COLOR_NAME: Record<TagColor, string> = {
  sky: 'голубой',
  orange: 'оранжевый',
  teal: 'бирюзовый',
  rose: 'малиновый',
  violet: 'фиолетовый',
  amber: 'янтарный',
  green: 'зелёный',
  pink: 'розовый',
  indigo: 'синий',
  slate: 'серый',
};
