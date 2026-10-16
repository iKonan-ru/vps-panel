import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { useServers } from '@/lib/servers';
import { useNavigate } from '@tanstack/react-router';
import { ArrowRight } from 'lucide-react';
import { useState } from 'react';

/**
 * Перенос сервера на другой: выбрать новый (уже добавленный в панель) и перейти к его
 * настройке с переносом - там видно, что поставится, что удалится, и что будет со старым.
 */
export function MigrateDialog({
  serverId,
  open,
  onClose,
}: {
  serverId: string;
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { data } = useServers();
  const others = (data ?? []).filter((x) => x.id !== serverId);
  const [target, setTarget] = useState('');
  const t = others.find((x) => x.id === target);
  return (
    <Dialog open={open} onClose={onClose} title="Перенос на другой сервер">
      <div className="flex flex-col gap-4 p-5">
        <div className="text-[13px] text-muted">
          На новом сервере ставятся те же сервисы с теми же портами, раскладываются данные этого
          сервера, клиенты панели переходят туда с теми же ключами. Этот сервер затем снимается или
          удаляется из панели&nbsp;&mdash; это выбирается на следующем шаге.
        </div>
        <Field label="Новый сервер" htmlFor="migrate-target">
          <Select id="migrate-target" value={target} onChange={(e) => setTarget(e.target.value)}>
            <option value="">{others.length ? 'не выбран' : 'других серверов в панели нет'}</option>
            {others.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
                {x.status === 'online' ? '' : ' (не в сети)'}
              </option>
            ))}
          </Select>
        </Field>
        {!others.length && (
          <Alert>
            Сначала нужно добавить новый сервер в панель: &laquo;Серверы&raquo; &mdash;
            &laquo;Добавить&raquo;
          </Alert>
        )}
        {t && t.status !== 'online' && <Alert tone="bad">Новый сервер не в сети</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button
            variant="primary"
            disabled={!t || t.status !== 'online'}
            onClick={() =>
              void navigate({
                to: '/servers/$id/setup',
                params: { id: target },
                search: { backup: undefined, migrate: serverId, wipe: undefined },
              })
            }
          >
            <ArrowRight className="size-4" />
            Дальше
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
