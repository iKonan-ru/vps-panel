import { SERVICES, accessAllows } from '@/components/clients/access-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import type { GClientRow, GServer, GService } from '@vps/protocol';
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Search, X } from 'lucide-react';
import { useState } from 'react';

type ClientSort = 'created' | 'name' | 'devices' | 'problems';
type ClientState = '' | 'on' | 'off' | 'problems' | 'limited';

/** Сортировка и фильтры списка клиентов. desc - по убыванию (новые, больше, проблемные - сверху). */
interface ClientsView {
  sort: ClientSort;
  desc: boolean;
  q: string;
  server: string;
  service: GService | '';
  state: ClientState;
}

const SORTS: { id: ClientSort; title: string; desc: boolean }[] = [
  { id: 'created', title: 'По дате', desc: true },
  { id: 'name', title: 'По имени', desc: false },
  { id: 'devices', title: 'По устройствам', desc: true },
  { id: 'problems', title: 'Проблемные', desc: true },
];

const STATES: { id: ClientState; title: string }[] = [
  { id: '', title: 'Все клиенты' },
  { id: 'on', title: 'Включённые' },
  { id: 'off', title: 'Выключенные' },
  { id: 'problems', title: 'С ошибками' },
  { id: 'limited', title: 'Выборочный доступ' },
];

const DEFAULT: ClientsView = {
  sort: 'created',
  desc: true,
  q: '',
  server: '',
  service: '',
  state: '',
};

/**
 * Сортировка помнится надолго, фильтры - до закрытия вкладки: из карточки клиента возвращаешься к
 * тому же списку, а завтра забытый фильтр не прячет клиентов.
 */
const SORT_KEY = 'vps-clients-sort';
const FILTER_KEY = 'vps-clients-filter';

function load(): ClientsView {
  const read = (store: () => Storage, key: string) => {
    try {
      return JSON.parse(store().getItem(key) ?? '{}') as Partial<ClientsView>;
    } catch {
      return {};
    }
  };
  const sort = read(() => localStorage, SORT_KEY);
  const filter = read(() => sessionStorage, FILTER_KEY);
  const v = { ...DEFAULT };
  if (SORTS.some((x) => x.id === sort.sort)) v.sort = sort.sort as ClientSort;
  if (typeof sort.desc === 'boolean') v.desc = sort.desc;
  if (typeof filter.q === 'string') v.q = filter.q;
  if (typeof filter.server === 'string') v.server = filter.server;
  if (SERVICES.some((x) => x.id === filter.service)) v.service = filter.service as GService;
  if (STATES.some((x) => x.id === filter.state)) v.state = filter.state as ClientState;
  return v;
}

function save(v: ClientsView) {
  try {
    localStorage.setItem(SORT_KEY, JSON.stringify({ sort: v.sort, desc: v.desc }));
    sessionStorage.setItem(
      FILTER_KEY,
      JSON.stringify({ q: v.q, server: v.server, service: v.service, state: v.state }),
    );
  } catch {}
}

export function useClientsView() {
  const [view, setView] = useState<ClientsView>(load);
  const set = (patch: Partial<ClientsView>) =>
    setView((v) => {
      const next = { ...v, ...patch };
      save(next);
      return next;
    });
  return [view, set] as const;
}

/** Порядок "сначала с проблемами": ошибки синхронизации весомее ожидающих её записей. */
const problems = (c: GClientRow) => c.states.error * 1000 + c.states.pending;

/** Доступ разрешает сервис, и он стоит на участвующем сервере; пустой фильтр - любой. */
function available(c: GClientRow, servers: GServer[], serverId: string, service: GService | '') {
  const list = servers.filter((s) => s.active && (!serverId || s.id === serverId));
  return list.some((s) =>
    (service ? [service] : SERVICES.map((x) => x.id)).some(
      (x) => s[x] && accessAllows(c.access, s.id, x),
    ),
  );
}

/** Отбор и порядок клиентов по виду списка. */
export function applyView(list: GClientRow[], servers: GServer[], v: ClientsView): GClientRow[] {
  const q = v.q.trim().toLowerCase();
  const out = list.filter((c) => {
    if (q && !`${c.name} ${c.note}`.toLowerCase().includes(q)) return false;
    if (v.state === 'on' && !c.enabled) return false;
    if (v.state === 'off' && c.enabled) return false;
    if (v.state === 'problems' && !c.states.error) return false;
    if (v.state === 'limited' && !c.limited) return false;
    if ((v.server || v.service) && !available(c, servers, v.server, v.service)) return false;
    return true;
  });
  const by = (c: GClientRow): number | string => {
    switch (v.sort) {
      case 'name':
        return c.name.toLocaleLowerCase('ru');
      case 'devices':
        return c.devices.length;
      case 'problems':
        return problems(c);
      default:
        return c.createdAt;
    }
  };
  const dir = v.desc ? -1 : 1;
  return out.sort((a, b) => {
    const x = by(a);
    const y = by(b);
    const cmp =
      typeof x === 'string' && typeof y === 'string'
        ? x.localeCompare(y, 'ru')
        : Number(x) - Number(y);
    // при равенстве - новые сверху, затем по имени: порядок не прыгает между обновлениями
    return (
      cmp * dir || b.createdAt.localeCompare(a.createdAt) || a.name.localeCompare(b.name, 'ru')
    );
  });
}

export const filtered = (v: ClientsView) => Boolean(v.q.trim() || v.server || v.service || v.state);

/** Поиск, фильтры и сортировка над списком клиентов. */
export function ClientsFilter({
  view,
  set,
  servers,
}: {
  view: ClientsView;
  set: (patch: Partial<ClientsView>) => void;
  servers: GServer[];
}) {
  const active = servers.filter((s) => s.active);
  // сервисы, которые стоят хоть где-то (или выбранного сервера)
  const here = active.filter((s) => !view.server || s.id === view.server);
  const services = SERVICES.filter((x) => here.some((s) => s[x.id]) || x.id === view.service);
  const DirIcon = view.desc ? ArrowDownWideNarrow : ArrowUpNarrowWide;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-0 basis-full sm:basis-56 sm:grow-0">
        <Search className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-muted" />
        <Input
          value={view.q}
          onChange={(e) => set({ q: e.target.value })}
          placeholder="Имя или заметка"
          aria-label="Поиск клиента"
          className="pl-8"
        />
      </div>
      <Select
        value={view.server}
        onChange={(e) => set({ server: e.target.value })}
        aria-label="Сервер"
        className="min-w-0 basis-[calc(50%-4px)] sm:w-auto sm:basis-auto"
      >
        <option value="">Все серверы</option>
        {active.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <Select
        value={view.service}
        onChange={(e) => set({ service: e.target.value as GService | '' })}
        aria-label="Сервис"
        className="min-w-0 basis-[calc(50%-4px)] sm:w-auto sm:basis-auto"
      >
        <option value="">Все сервисы</option>
        {services.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </Select>
      <Select
        value={view.state}
        onChange={(e) => set({ state: e.target.value as ClientState })}
        aria-label="Состояние"
        className="min-w-0 basis-[calc(50%-4px)] sm:w-auto sm:basis-auto"
      >
        {STATES.map((x) => (
          <option key={x.id} value={x.id}>
            {x.title}
          </option>
        ))}
      </Select>
      <div className="flex min-w-0 basis-[calc(50%-4px)] items-center gap-1 sm:basis-auto">
        <Select
          value={view.sort}
          onChange={(e) => {
            const s = SORTS.find((x) => x.id === e.target.value);
            // у каждой сортировки своё естественное направление
            if (s) set({ sort: s.id, desc: s.desc });
          }}
          aria-label="Сортировка"
          className="min-w-0 grow sm:w-auto"
        >
          {SORTS.map((x) => (
            <option key={x.id} value={x.id}>
              {x.title}
            </option>
          ))}
        </Select>
        <Button
          size="icon"
          variant="ghost"
          onClick={() => set({ desc: !view.desc })}
          aria-label={view.desc ? 'По убыванию' : 'По возрастанию'}
          title={view.desc ? 'По убыванию' : 'По возрастанию'}
        >
          <DirIcon className="size-4" />
        </Button>
      </div>
      {filtered(view) && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => set({ q: '', server: '', service: '', state: '' })}
        >
          <X className="size-3.5" />
          Сбросить
        </Button>
      )}
    </div>
  );
}
