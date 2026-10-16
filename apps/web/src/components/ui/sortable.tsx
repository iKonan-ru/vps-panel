import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
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
        <DragOverlay>
          {active !== undefined && (
            <div className="rounded-lg bg-surface shadow-lg ring-1 ring-border">
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
      className={isDragging ? 'opacity-30' : undefined}
    >
      {children(handle)}
    </div>
  );
}
