import { InstallAgent } from '@/components/server/install-agent';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { actions } from '@/lib/actions';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

export function RenameDialog({
  serverId,
  name,
  open,
  onClose,
}: { serverId: string; name: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(name);
  const save = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await save.run(async () => {
      await actions.patchServer(serverId, { name: v.trim() });
      await qc.invalidateQueries({ queryKey: ['servers'] });
    });
    if (ok) onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} title="Переименовать">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Имя сервера" htmlFor="rn-name">
          <Input
            id="rn-name"
            value={v}
            onChange={(e) => setV(e.target.value)}
            required
            maxLength={64}
          />
        </Field>
        {save.error && <Alert tone="bad">{save.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={save.busy}>
            Сохранить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

export function ReinstallDialog({
  serverId,
  host,
  open,
  onClose,
}: { serverId: string; host: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  return (
    <Dialog open={open} onClose={onClose} title="Переустановка агента" wide>
      <div className="text-sm text-muted">Сервисы на сервере продолжат работать</div>
      <InstallAgent
        serverId={serverId}
        host={host}
        onDone={() => qc.invalidateQueries({ queryKey: ['servers'] })}
      />
    </Dialog>
  );
}

export function RemoveDialog({
  serverId,
  name,
  open,
  onClose,
}: { serverId: string; name: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const nav = useNavigate();
  const [typed, setTyped] = useState('');
  const op = useAction();
  async function go() {
    const ok = await op.run(async () => {
      await actions.deleteServer(serverId);
      // сначала уходим со страницы сервера: перезапрос удалённого сервера (404 с повторами)
      // держал бы окно открытым; потом убираем его из кэша и обновляем список
      await nav({ to: '/' });
    });
    if (!ok) return;
    qc.removeQueries({ queryKey: ['servers', serverId] });
    void qc.invalidateQueries({ queryKey: ['servers'], exact: true });
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Удалить \u00ab${name}\u00bb из панели?`}>
      <div className="text-sm text-muted">
        Журнал и ручные правила firewall удалятся из панели. На самом сервере ничего не изменится.
      </div>
      <Field
        label={
          <>
            Имя для подтверждения: <span className="font-mono">{name}</span>
          </>
        }
        htmlFor="rm-name"
      >
        <Input
          id="rm-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </Field>
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="danger" disabled={typed !== name || op.busy} onClick={go}>
          Удалить
        </Button>
      </div>
    </Dialog>
  );
}
