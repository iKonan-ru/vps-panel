import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { actions } from '@/lib/actions';
import { useAction } from '@/lib/use-action';
import { useState } from 'react';

/** Перезагрузка с подтверждением именем сервера. */
export function RebootDialog({
  serverId,
  name,
  open,
  onClose,
}: { serverId: string; name: string; open: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const op = useAction();
  async function go() {
    if (await op.run(() => actions.reboot(serverId, typed))) onClose();
  }
  return (
    <Dialog open={open} onClose={onClose} title={`Перезагрузить \u00ab${name}\u00bb?`}>
      <div className="text-sm text-muted">
        VPN-соединения на сервере оборвутся на время перезагрузки
      </div>
      <Field
        label={
          <>
            Имя для подтверждения: <span className="font-mono">{name}</span>
          </>
        }
        htmlFor="reboot-name"
      >
        <Input
          id="reboot-name"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoComplete="off"
        />
      </Field>
      {op.error && <Alert tone="bad">{op.error}</Alert>}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>Отмена</Button>
        <Button variant="danger" disabled={typed !== name || op.busy} onClick={go}>
          Перезагрузить
        </Button>
      </div>
    </Dialog>
  );
}
