/** fn через firstMs, затем каждые everyMs; таймеры не держат процесс. Возвращает остановку. */
export function schedule(fn: () => void, firstMs: number, everyMs: number): () => void {
  const first = setTimeout(fn, firstMs).unref();
  const timer = setInterval(fn, everyMs).unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
