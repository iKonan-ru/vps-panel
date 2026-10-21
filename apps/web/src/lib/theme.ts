const KEY = 'vps-theme';

type Theme = 'dark' | 'light';

export function getTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {}
  return 'dark';
}

export function applyTheme(t: Theme) {
  document.documentElement.classList.toggle('dark', t === 'dark');
  // цвет строки состояния в установленном приложении и в мобильном браузере
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', t === 'dark' ? '#0f1115' : '#f5f6f8');
  try {
    localStorage.setItem(KEY, t);
  } catch {}
}

/**
 * Смена темы перетеканием (View Transitions: снимок старой темы растворяется в новой); браузер без
 * них или "уменьшить движение" - сразу.
 */
export function toggleTheme(): Theme {
  const next: Theme = getTheme() === 'dark' ? 'light' : 'dark';
  const run = () => applyTheme(next);
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && typeof document.startViewTransition === 'function')
    document.startViewTransition(run);
  else run();
  return next;
}
