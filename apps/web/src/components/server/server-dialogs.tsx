import { InstallAgent } from '@/components/server/install-agent';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { TagInput } from '@/components/ui/tag-input';
import { actions } from '@/lib/actions';
import { useTags } from '@/lib/tags';
import { useAction } from '@/lib/use-action';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { type FormEvent, useState } from 'react';

/** Имя и теги сервера. Монтируется на время открытия (Presence): каждый раз - текущие данные. */
export function EditServerDialog({
  serverId,
  name,
  tags,
  onClose,
}: { serverId: string; name: string; tags: string[]; onClose: () => void }) {
  const qc = useQueryClient();
  const [v, setV] = useState(name);
  const [t, setT] = useState(tags);
  const { data: tagList } = useTags();
  const save = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const ok = await save.run(async () => {
      await actions.patchServer(serverId, { name: v.trim(), tags: t });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['servers'] }),
        qc.invalidateQueries({ queryKey: ['tags'] }),
      ]);
    });
    if (ok) onClose();
  }
  return (
    <Dialog open onClose={onClose} title="Изменить сервер">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Имя сервера" htmlFor="ed-name">
          <Input
            id="ed-name"
            value={v}
            onChange={(e) => setV(e.target.value)}
            required
            maxLength={64}
            disabled={save.busy}
          />
        </Field>
        <Field
          label="Теги"
          htmlFor="ed-tags"
          hint={'Цвет, переименование и удаление тегов\u00a0\u2014 в\u00a0настройках'}
        >
          <TagInput id="ed-tags" value={t} onChange={setT} tags={tagList} disabled={save.busy} />
        </Field>
        {save.error && <Alert tone="bad">{save.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose} disabled={save.busy}>
            Отмена
          </Button>
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
