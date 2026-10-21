import { type DependencyList, useLayoutEffect, useRef, useState } from 'react';

export interface SliderRect {
  left: number;
  top: number;
  width: number;
  height: number;
  /** Переезд с анимацией: не при первом показе (сразу на месте). */
  animate: boolean;
}

/**
 * Скользящий индикатор выбранного пункта (подсветка раздела в меню, полоса в полосе вкладок):
 * box - контейнер пунктов, выбранный помечен data-active="true"; rect - его место в контейнере.
 * Пересчёт - при смене deps и при изменении размеров (шрифт загрузился, меню свернули).
 */
export function useSlider<T extends HTMLElement>(deps: DependencyList) {
  const box = useRef<T>(null);
  const [rect, setRect] = useState<SliderRect | null>(null);
  // выбранный пункт ищется в DOM: пересчёт - по deps вызывающего
  useLayoutEffect(() => {
    const root = box.current;
    const el = root?.querySelector<HTMLElement>('[data-active="true"]');
    if (!root || !el) {
      setRect(null);
      return;
    }
    const place = () =>
      setRect((prev) => {
        const next = {
          left: el.offsetLeft,
          top: el.offsetTop,
          width: el.offsetWidth,
          height: el.offsetHeight,
        };
        if (
          prev &&
          prev.left === next.left &&
          prev.top === next.top &&
          prev.width === next.width &&
          prev.height === next.height
        )
          return prev;
        return { ...next, animate: prev !== null };
      });
    place();
    const ro = new ResizeObserver(place);
    ro.observe(el);
    ro.observe(root);
    return () => ro.disconnect();
  }, deps);
  return { box, rect };
}
