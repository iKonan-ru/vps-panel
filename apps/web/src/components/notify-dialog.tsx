import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import {
  NOTIFY_GROUPS,
  NOTIFY_PARAM_DEFAULTS,
  NOTIFY_PARAM_LIMITS,
  type NotifyEvent,
  type NotifyEvents,
  type NotifyParams,
} from '@vps/protocol';
import { useEffect, useId, useState } from 'react';

export interface NotifyChoice extends NotifyParams {
  events: NotifyEvents;
  mutedServers: string[];
}

/** Сводка для блока настроек: сколько событий включено, сколько серверов отключено. */
export function notifySummary(c: NotifyChoice): string {
  const all = NOTIFY_GROUPS.flatMap((g) => g.events);
  const on = all.filter((e) => c.events[e.key]).length;
  const muted = c.mutedServers.length;
  return `${on === all.length ? 'все события' : `${on} из ${all.length} событий`}${
    muted ? `, без ${muted} ${muted === 1 ? 'сервера' : 'серверов'}` : ''
  }`;
}

/** Окно "Какие уведомления": события по группам, их числа и серверы, о которых не писать. */
export function NotifyDialog({
  open,
  onClose,
  value,
}: { open: boolean; onClose: () => void; value: NotifyChoice }) {
  const qc = useQueryClient();
  const { data: servers } = useServers();
  const [ev, setEv] = useState<NotifyEvents>(value.events);
  const [params, setParams] = useState<Record<keyof NotifyParams, string>>(() => strParams(value));
  const [muted, setMuted] = useState<string[]>(value.mutedServers);
  const op = useAction();
  const { setError } = op;

  // при каждом открытии - с сохранённого
  useEffect(() => {
    if (!open) return;
    setEv(value.events);
    setParams(strParams(value));
    setMuted(value.mutedServers);
    setError(null);
  }, [open, value, setError]);

  const bad = (Object.keys(params) as (keyof NotifyParams)[]).find((k) => {
    const v = Number(params[k]);
    const [lo, hi] = NOTIFY_PARAM_LIMITS[k];
    return params[k].trim() === '' || !Number.isInteger(v) || v < lo || v > hi;
  });

  async function save() {
    await op.run(async () => {
      await api('/api/notify/telegram', {
        method: 'PUT',
        json: {
          events: ev,
          mutedServers: muted,
          ...Object.fromEntries(
            (Object.keys(params) as (keyof NotifyParams)[]).map((k) => [k, Number(params[k])]),
          ),
        },
      });
      await qc.invalidateQueries({ queryKey: ['tg-settings'] });
      onClose();
    });
  }

  const setGroup = (keys: NotifyEvent[], on: boolean) =>
    setEv({ ...ev, ...Object.fromEntries(keys.map((k) => [k, on])) });

  return (
    <Dialog open={open} onClose={onClose} title="События">
      {NOTIFY_GROUPS.map((g) => {
        const keys = g.events.map((e) => e.key);
        const on = keys.filter((k) => ev[k]).length;
        return (
          <section key={g.id} className="flex flex-col">
            <div className="flex items-center gap-3 border-b border-border pb-2">
              <div className="grow font-medium">{g.title}</div>
              {keys.length > 1 && (
                <span className="text-xs text-muted">
                  {on} из {keys.length}
                </span>
              )}
              <Switch
                label={`${g.title}: все`}
                checked={on > 0}
                onChange={() => setGroup(keys, on === 0)}
              />
            </div>
            {keys.length > 1 &&
              g.events.map((e) => (
                <div key={e.key} className="flex items-start gap-3 py-2 pl-3">
                  <div className="min-w-0 grow">
                    <div className={cn('text-[13px]', !ev[e.key] && 'text-muted')}>{e.title}</div>
                    {e.hint && <div className="text-xs text-muted">{e.hint}</div>}
                    {e.param && (
                      <ParamInput
                        label={e.param.label}
                        value={params[e.param.key]}
                        k={e.param.key}
                        disabled={!ev[e.key]}
                        onChange={(v) => e.param && setParams({ ...params, [e.param.key]: v })}
                      />
                    )}
                  </div>
                  <Switch
                    label={e.title}
                    checked={ev[e.key]}
                    onChange={() => setEv({ ...ev, [e.key]: !ev[e.key] })}
                  />
                </div>
              ))}
            {keys.length === 1 &&
              g.events.map((e) => (
                <div key={e.key} className="py-2 pl-3">
                  <div className={cn('text-[13px]', !ev[e.key] && 'text-muted')}>{e.title}</div>
                  {e.hint && <div className="text-xs text-muted">{e.hint}</div>}
                  {e.param && (
                    <ParamInput
                      label={e.param.label}
                      value={params[e.param.key]}
                      k={e.param.key}
                      disabled={!ev[e.key]}
                      onChange={(v) => e.param && setParams({ ...params, [e.param.key]: v })}
                    />
                  )}
                </div>
              ))}
          </section>
        );
      })}
      {servers && servers.length > 0 && (
        <section className="flex flex-col">
          <div className="flex items-center gap-3 border-b border-border pb-2">
            <div className="grow font-medium">Серверы</div>
            <span className="text-xs text-muted">
              {servers.length - servers.filter((s) => muted.includes(s.id)).length} из{' '}
              {servers.length}
            </span>
          </div>
          <div className="pt-1 pl-3 text-xs text-muted">
            Об отключённых серверах уведомления не приходят
          </div>
          {servers.map((s) => {
            const on = !muted.includes(s.id);
            return (
              <div key={s.id} className="flex items-center gap-3 py-2 pl-3">
                <div className={cn('min-w-0 grow truncate text-[13px]', !on && 'text-muted')}>
                  {s.name} <span className="text-xs text-muted">{s.host}</span>
                </div>
                <Switch
                  label={s.name}
                  checked={on}
                  onChange={() => setMuted(on ? [...muted, s.id] : muted.filter((x) => x !== s.id))}
                />
              </div>
            );
          })}
        </section>
      )}
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose} disabled={op.busy}>
          Отмена
        </Button>
        <Button variant="primary" onClick={save} disabled={op.busy || bad !== undefined}>
          Сохранить
        </Button>
      </div>
    </Dialog>
  );
}

function strParams(v: NotifyParams): Record<keyof NotifyParams, string> {
  return Object.fromEntries(
    (Object.keys(NOTIFY_PARAM_DEFAULTS) as (keyof NotifyParams)[]).map((k) => [
      k,
      String(v[k] ?? NOTIFY_PARAM_DEFAULTS[k]),
    ]),
  ) as Record<keyof NotifyParams, string>;
}

function ParamInput({
  label,
  value,
  k,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  k: keyof NotifyParams;
  disabled: boolean;
  onChange: (v: string) => void;
}) {
  const [lo, hi] = NOTIFY_PARAM_LIMITS[k];
  const id = useId();
  return (
    <div className="mt-1.5 flex items-center gap-2 text-xs text-muted">
      <label htmlFor={id}>{label}</label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={lo}
        max={hi}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 w-20 px-2 text-[13px]"
      />
    </div>
  );
}
