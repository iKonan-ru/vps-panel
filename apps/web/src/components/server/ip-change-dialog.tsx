import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { useQueryClient } from '@tanstack/react-query';
import { Check, CircleAlert, X as XIcon } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface Step {
  name: string;
  level: 'ok' | 'warn' | 'fail';
  detail: string;
}

/**
 * "Сменить IP-адрес": хостер выдал новый адрес. Порядок: поправить A-запись имени сервера на
 * новый адрес -> проверка (DNS у публичных резолверов, агент с нового адреса, TCP до SSH) ->
 * переключение (адрес в панели, ссылки на личных страницах, маршрут до Telegram, проверки из РФ).
 */
export function IpChangeDialog({
  serverId,
  host,
  open,
  onClose,
}: {
  serverId: string;
  host: string;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={open} onClose={onClose} title="Сменить IP-адрес сервера">
      {open && <IpChangeForm serverId={serverId} host={host} onClose={onClose} />}
    </Dialog>
  );
}

function IpChangeForm({
  serverId,
  host,
  onClose,
}: {
  serverId: string;
  host: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [ip, setIp] = useState('');
  const [steps, setSteps] = useState<Step[] | null>(null);
  const [canSwitch, setCanSwitch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function check(e?: FormEvent) {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ steps: Step[]; canSwitch: boolean }>(
        `/api/servers/${serverId}/ip-change/check`,
        { method: 'POST', json: { ip: ip.trim() } },
      );
      setSteps(r.steps);
      setCanSwitch(r.canSwitch);
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    setBusy(true);
    setErr(null);
    try {
      await api(`/api/servers/${serverId}/ip-change`, { method: 'POST', json: { ip: ip.trim() } });
      setDone(true);
      await qc.invalidateQueries({ queryKey: ['servers'] });
      void qc.invalidateQueries({ queryKey: ['client-host', serverId] });
    } catch (x) {
      setErr((x as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="flex flex-col gap-3">
        <Alert tone="ok">
          Адрес сервера в панели - {ip.trim()}. Ссылки и конфиги на личных страницах сверка обновит
          в течение нескольких минут; доступность из России перепроверяется.
        </Alert>
        <div className="flex justify-end">
          <Button onClick={onClose}>Закрыть</Button>
        </div>
      </div>
    );

  return (
    <form className="flex flex-col gap-3" onSubmit={(e) => void check(e)}>
      <div className="text-[13px] text-muted">
        Сейчас: <span className="font-mono text-text">{host}</span>. Сначала поправь A-запись имени
        сервера ("Адрес для клиентов" в "Обзоре") на новый адрес, потом проверь и переключи.
      </div>
      <Field label="Новый IP-адрес" htmlFor="ip-new">
        <Input
          id="ip-new"
          className="font-mono"
          value={ip}
          autoComplete="off"
          onChange={(e) => {
            setIp(e.target.value);
            setSteps(null);
            setCanSwitch(false);
          }}
          placeholder="203.0.113.10"
        />
      </Field>
      {steps && (
        <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-bg p-3 text-[13px]">
          {steps.map((st) => (
            <div key={st.name} className="flex items-start gap-2">
              {st.level === 'ok' ? (
                <Check className="mt-0.5 size-4 shrink-0 text-ok" />
              ) : st.level === 'warn' ? (
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
              ) : (
                <XIcon className="mt-0.5 size-4 shrink-0 text-bad" />
              )}
              <span className="min-w-0">
                <span className="font-medium">{st.name}</span>
                <span
                  className={cn(
                    'block break-words text-xs',
                    st.level === 'fail' ? 'text-bad' : 'text-muted',
                  )}
                >
                  {st.detail}
                </span>
              </span>
            </div>
          ))}
        </div>
      )}
      {err && <Alert tone="bad">{err}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={onClose}>Отмена</Button>
        <Button type="submit" disabled={busy || !ip.trim()}>
          {steps ? 'Проверить снова' : 'Проверить'}
        </Button>
        <Button
          variant="primary"
          disabled={busy || !canSwitch}
          title={canSwitch ? undefined : 'Сначала проверка: имя должно указывать на новый адрес'}
          onClick={() => void apply()}
        >
          Переключить
        </Button>
      </div>
    </form>
  );
}
