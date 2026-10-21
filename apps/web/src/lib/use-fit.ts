import { useLayoutEffect, useRef, useState } from 'react';

/**
 * Ряд кнопок, который не помещается, отдаёт хвост в меню "Ещё". Сколько первых элементов
 * помещается: measure - невидимая копия ряда целиком в одну строку, элементы в ней помечены
 * data-fit; row - видимый ряд, его ширина - доступное место. Ширина ряда задаётся полной (full),
 * а сжимает его родитель: так число видимых кнопок не влияет на ширину и не дёргается по кругу.
 * reserve - место под кнопку меню с отступом (нужно, только когда что-то не поместилось), min -
 * сколько первых элементов остаются в ряду всегда.
 */
export function useFit(count: number, reserve: number, min = 0, enabled = true) {
  const row = useRef<HTMLDivElement>(null);
  const measure = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(count);
  const [full, setFull] = useState<number | undefined>(undefined);

  useLayoutEffect(() => {
    const r = row.current;
    const m = measure.current;
    if (!enabled || !r || !m) {
      setFit(count);
      return;
    }
    const calc = () => {
      const box = m.getBoundingClientRect();
      // скрытый ряд (узкий экран, display: none) - мерить нечего
      if (box.width === 0) return;
      const ends = [...m.querySelectorAll<HTMLElement>('[data-fit]')].map(
        (el) => el.getBoundingClientRect().right - box.left,
      );
      setFull(Math.ceil(box.width));
      const avail = r.clientWidth;
      if (box.width <= avail + 0.5) {
        setFit(count);
        return;
      }
      let k = 0;
      while (k < ends.length && (ends[k] ?? 0) + reserve <= avail + 0.5) k++;
      setFit(Math.max(min, k));
    };
    calc();
    const ro = new ResizeObserver(calc);
    ro.observe(r);
    ro.observe(m);
    return () => ro.disconnect();
  }, [count, reserve, min, enabled]);

  return { row, measure, fit: enabled ? fit : count, full: enabled ? full : undefined };
}
