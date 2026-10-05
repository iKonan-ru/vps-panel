import { Button } from '@/components/ui/button';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useState } from 'react';

/** Постраничный вывод длинных списков (журналы): items - строки текущей страницы. */
export function usePaged<T>(rows: T[], size = 10) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / size));
  // список мог укоротиться (другой фильтр, удаление) - остаёмся на последней странице
  const p = Math.min(page, pages - 1);
  return {
    items: rows.slice(p * size, (p + 1) * size),
    page: p,
    pages,
    total: rows.length,
    size,
    setPage,
  };
}

/** Переключатель страниц под таблицей; при одной странице не показывается. */
export function Pager({
  page,
  pages,
  total,
  size,
  setPage,
}: Omit<ReturnType<typeof usePaged>, 'items'>) {
  if (pages <= 1) return null;
  return (
    <div className="flex items-center justify-end gap-2 border-t border-border px-4 py-2 text-xs text-muted">
      <span>
        {page * size + 1}-{Math.min((page + 1) * size, total)} из {total}
      </span>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Предыдущая страница"
        disabled={page === 0}
        onClick={() => setPage(page - 1)}
      >
        <ChevronLeft className="size-4" />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Следующая страница"
        disabled={page >= pages - 1}
        onClick={() => setPage(page + 1)}
      >
        <ChevronRight className="size-4" />
      </Button>
    </div>
  );
}
