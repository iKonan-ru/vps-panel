import { cn } from '@/lib/cn';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DropAnimation,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { restrictToVerticalAxis } from '@dnd-kit/modifiers';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { createPortal } from 'react-dom';

const DROP_MS = 220;
const DROP_EASE = 'cubic-bezier(0.22, 1, 0.36, 1)';

/**
 * Возврат поднятого элемента на место после отпускания. Стандартная анимация dnd-kit меряет копию
 * под пальцем по её содержимому - увеличенному и наклонённому - и ставит по левому верхнему углу:
 * копия приезжала со сдвигом и в конце прыгала. Здесь: обёртка копии (без масштаба) едет точно на
 * место строки, а сама копия за то же время теряет масштаб, наклон, тень и фон - в конце она
 * совпадает со строкой пиксель в пиксель. Строка всё это время скрыта и появляется сразу, без
 * плавного проявления (иначе мигает: копия пропала, строка ещё прозрачная).
 */
const dropAnimation: DropAnimation = ({ active, dragOverlay, transform }) => {
  const row = active.node;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const box = dragOverlay.node.getBoundingClientRect();
  const final = {
    ...transform,
    x: transform.x - (box.left - active.rect.left),
    y: transform.y - (box.top - active.rect.top),
    scaleX: 1,
    scaleY: 1,
  };
  const opts = { duration: DROP_MS, easing: DROP_EASE, fill: 'forwards' as const };
  const lifted = dragOverlay.node.firstElementChild;
  if (lifted instanceof HTMLElement) {
    lifted.animate(
      { scale: '1', rotate: '0deg', boxShadow: 'none', backgroundColor: 'transparent' },
      opts,
    );
  }
  row.style.opacity = '0';
  const move = dragOverlay.node.animate(
    [
      { transform: CSS.Transform.toString(transform) },
      { transform: CSS.Transform.toString(final) },
    ],
    opts,
  );
  return new Promise<void>((resolve) => {
    move.onfinish = () => {
      row.style.opacity = '';
      resolve();
    };
  });
};

/** Список с перетаскиванием за ручку; children получает элемент и ручку для разметки строки. */
export function SortableList<T>({
  items,
  getId,
  onReorder,
  children,
}: {
  items: T[];
  getId: (item: T) => string;
  onReorder: (items: T[]) => void;
  children: (item: T, handle: ReactNode, index: number) => ReactNode;
}) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = items.map(getId);
  const [activeId, setActiveId] = useState<string | null>(null);
  const activeIndex = activeId === null ? -1 : ids.indexOf(activeId);
  const active = activeIndex >= 0 ? items[activeIndex] : undefined;
  const onDragEnd = ({ active, over }: DragEndEvent) => {
    setActiveId(null);
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from >= 0 && to >= 0) onReorder(arrayMove(items, from, to));
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      modifiers={[restrictToVerticalAxis]}
      // служебные блоки для экранных читалок - не внутрь списка, иначе они последние
      // дети контейнера и ломают разделители divide-y
      accessibility={{ container: document.body }}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        {items.map((item, i) => (
          <SortableItem key={ids[i]} id={ids[i] ?? ''}>
            {(handle) => children(item, handle, i)}
          </SortableItem>
        ))}
      </SortableContext>
      {createPortal(
        <DragOverlay dropAnimation={dropAnimation}>
          {active !== undefined && (
            // поднятый элемент: чуть крупнее, с тенью и лёгким наклоном - видно, что он "в руке"
            <div className="rotate-[0.6deg] scale-[1.02] rounded-lg bg-surface shadow-2xl ring-1 ring-accent/40">
              {children(active, <Grip />, activeIndex)}
            </div>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

const GRIP =
  'flex h-7 w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted hover:text-text active:cursor-grabbing';

/** Ручка в копии строки под курсором: только вид, без обработчиков. */
function Grip() {
  return (
    <span className={GRIP}>
      <GripVertical className="size-4" />
    </span>
  );
}

function SortableItem({
  id,
  children,
}: { id: string; children: (handle: ReactNode) => ReactNode }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id });
  const handle = (
    <button
      type="button"
      ref={setActivatorNodeRef}
      className={GRIP}
      aria-label="Перетащить"
      title="Перетащить"
      {...attributes}
      {...listeners}
    >
      <GripVertical className="size-4" />
    </button>
  );
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      // без плавной смены прозрачности: после отпускания строка должна появиться сразу
      className={cn(isDragging && 'opacity-30')}
    >
      {children(handle)}
    </div>
  );
}
