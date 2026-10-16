import { useEffect, useRef, useState } from 'react';

const reduced =
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Плавное число: бежит к target от текущего значения (при появлении - от нуля), ease-out за ms.
 * При "уменьшить движение" в системе - сразу target.
 */
export function useTween(target: number, ms = 700): number {
  const [value, setValue] = useState(reduced ? target : 0);
  const current = useRef(value);
  useEffect(() => {
    const from = current.current;
    if (reduced || !Number.isFinite(target) || !Number.isFinite(from) || from === target) {
      current.current = target;
      setValue(target);
      return;
    }
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / ms);
      const v = from + (target - from) * (1 - (1 - k) ** 3);
      current.current = v;
      setValue(v);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return value;
}
