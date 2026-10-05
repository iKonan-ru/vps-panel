const KEY = 'vps-chunk-reload';

/**
 * Загрузка куска сборки. После выкладки старых кусков на сервере нет, а открытая вкладка ссылается
 * на них: один раз перезагружаем страницу (маршруты так же обрабатывает lazyRouteComponent).
 */
export function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  return load().then(
    (m) => {
      sessionStorage.removeItem(KEY);
      return m;
    },
    (e: unknown) => {
      if (!sessionStorage.getItem(KEY)) {
        sessionStorage.setItem(KEY, '1');
        location.reload();
      }
      throw e;
    },
  );
}
