import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/cn';
import {
  SERVICES as CATALOG,
  type GBinding,
  type GClientAccess,
  type GServer,
  type GService,
} from '@vps/protocol';
import { Check } from 'lucide-react';

/** Сервисы в доступе клиента: ключ привязки и как сервис называется у клиентов. */
export const SERVICES: { id: GService; title: string }[] = CATALOG.map((s) => ({
  id: s.binding,
  title: s.clientTitle,
}));

/** Сервис установлен на сервере (по последнему снимку). */
const installed = (s: GServer, service: GService) => s[service];

/** Серверы, на которых заводятся глобальные клиенты: включены и это не сервер панели. */
export const accessServers = (servers: GServer[]) => servers.filter((s) => s.active);

/** Разрешён ли клиенту сервис на сервере (как allowed() в сверке). */
export function accessAllows(access: GClientAccess, serverId: string, service: GService) {
  return !access || access.some((a) => a.serverId === serverId && a.services.includes(service));
}

/** Привязки, которые сверка уберёт с серверов при новом доступе. */
export function accessRemoves(bindings: GBinding[], access: GClientAccess): GBinding[] {
  return bindings.filter((b) => !accessAllows(access, b.serverId, b.service));
}

/**
 * Доступ клиента: все серверы и сервисы (новые тоже) или выбор по серверам - тогда заводится
 * только отмеченное, новое само не добавляется. Сервер - карточка с переключателем "весь сервер"
 * и кнопками сервисов; сервис, которого на сервере нет, отмечается заранее и заведётся после
 * установки.
 */
export function AccessEditor({
  value,
  onChange,
  servers,
  bindings = [],
}: {
  value: GClientAccess;
  onChange: (v: GClientAccess) => void;
  servers: GServer[];
  /** уже заведённое у клиента: при переходе на выборочный доступ остаётся отмеченным */
  bindings?: GBinding[];
}) {
  const list = accessServers(servers);
  // установленное и уже заведённое: снимаешь лишнее, а не теряешь то, чего на сервере сейчас
  // нет (переустановка)
  const preset = (s: GServer) =>
    SERVICES.map((x) => x.id).filter(
      (id) => installed(s, id) || bindings.some((b) => b.serverId === s.id && b.service === id),
    );
  const setServer = (serverId: string, services: GService[]) => {
    const cur = value ?? [];
    onChange([...cur.filter((a) => a.serverId !== serverId), { serverId, services }]);
  };
  const selected = (s: GServer) => SERVICES.filter((x) => accessAllows(value, s.id, x.id));
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start gap-3 rounded-lg border border-border p-3">
        <div className="min-w-0 grow">
          <div className="text-sm font-medium">Все серверы и сервисы</div>
          <div className="text-xs text-muted">
            {value === null
              ? 'новые серверы и сервисы тоже попадут к клиенту'
              : 'новые серверы и сервисы не добавятся'}
          </div>
        </div>
        <Switch
          checked={value === null}
          onChange={() =>
            onChange(
              value === null ? list.map((s) => ({ serverId: s.id, services: preset(s) })) : null,
            )
          }
          label="Все серверы и сервисы"
        />
      </div>
      {value !== null && list.length === 0 && (
        <div className="text-[13px] text-muted">Нет серверов для клиентов</div>
      )}
      {value !== null &&
        list.map((s) => {
          const on = selected(s).map((x) => x.id);
          const missing = SERVICES.filter((x) => !installed(s, x.id));
          return (
            <div key={s.id} className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
              <div className="flex items-center gap-3">
                <div className="min-w-0 grow truncate text-sm font-medium">{s.name}</div>
                <Switch
                  checked={on.length > 0}
                  onChange={() => {
                    // весь сервер: выключить - ничего, включить - установленное и заведённое,
                    // а на пустом сервере (переустановка) - всё
                    const next = preset(s);
                    setServer(
                      s.id,
                      on.length > 0 ? [] : next.length ? next : SERVICES.map((x) => x.id),
                    );
                  }}
                  label={`${s.name}: весь сервер`}
                />
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {SERVICES.map((x) => {
                  const active = on.includes(x.id);
                  return (
                    <Button
                      key={x.id}
                      type="button"
                      variant={active ? 'primary' : 'default'}
                      aria-pressed={active}
                      className={cn('justify-center', !installed(s, x.id) && 'border-dashed')}
                      onClick={() =>
                        setServer(s.id, active ? on.filter((id) => id !== x.id) : [...on, x.id])
                      }
                    >
                      {active && <Check className="size-4" />}
                      {x.title}
                    </Button>
                  );
                })}
              </div>
              {missing.length > 0 && (
                <div className="text-xs text-muted">
                  {`Нет на сервере: ${missing.map((x) => x.title).join(', ')}`}
                  {missing.some((x) => on.includes(x.id)) &&
                    '; выбранные добавятся после установки'}
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
