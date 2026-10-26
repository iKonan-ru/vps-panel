import type { Container } from '@vps/protocol';
import { plural } from './format';

/** Состояние контейнера по-русски. */
export const stateTitle: Record<Container['state'], string> = {
  running: 'работает',
  restarting: 'перезапускается',
  paused: 'на паузе',
  exited: 'остановлен',
  created: 'создан',
  removing: 'удаляется',
  dead: 'сбой',
};

const UNITS: Record<string, [string, string, string]> = {
  second: ['секунду', 'секунды', 'секунд'],
  minute: ['минуту', 'минуты', 'минут'],
  hour: ['час', 'часа', 'часов'],
  day: ['день', 'дня', 'дней'],
  week: ['неделю', 'недели', 'недель'],
  month: ['месяц', 'месяца', 'месяцев'],
  year: ['год', 'года', 'лет'],
};

/** Длительность docker ("3 days", "About an hour", "Less than a second") по-русски. */
function duration(s: string): string | null {
  const t = s.trim();
  if (/^less than a second$/i.test(t)) return 'меньше секунды';
  const about = /^about an? (second|minute|hour)$/i.exec(t);
  if (about) return `около ${about[1]?.toLowerCase() === 'hour' ? 'часа' : 'минуты'}`;
  const m = /^(\d+) (second|minute|hour|day|week|month|year)s?$/i.exec(t);
  const unit = m && UNITS[m[2]?.toLowerCase() ?? ''];
  if (!m || !unit) return null;
  const n = Number(m[1]);
  return `${n}\u00a0${plural(n, ...unit)}`;
}

const HEALTH: Record<string, string> = {
  healthy: 'проверка здоровья: в порядке',
  unhealthy: 'проверка здоровья: сбой',
  'health: starting': 'проверка здоровья: выполняется',
  paused: 'на паузе',
};

/**
 * Строка состояния docker ps ("Up 3 days (healthy)", "Exited (0) 2 hours ago") по-русски;
 * незнакомый вид - как есть.
 */
export function statusTitle(status: string): string {
  const up = /^Up (.+?)(?: \(([^)]+)\))?$/.exec(status);
  if (up) {
    const d = duration(up[1] ?? '');
    if (d) {
      const h = up[2] ? HEALTH[up[2].toLowerCase()] : undefined;
      if (up[2] && !h) return status;
      return `работает ${d}${h ? `, ${h}` : ''}`;
    }
  }
  const stop = /^(Exited|Restarting) \((-?\d+)\) (.+) ago$/.exec(status);
  if (stop) {
    const d = duration(stop[3] ?? '');
    if (d)
      return stop[1] === 'Exited'
        ? `остановлен ${d} назад, код ${stop[2]}`
        : `перезапуск ${d} назад, код ${stop[2]}`;
  }
  if (status === 'Created') return 'создан';
  if (status === 'Removal In Progress') return 'удаляется';
  if (status === 'Dead') return 'сбой';
  return status;
}
