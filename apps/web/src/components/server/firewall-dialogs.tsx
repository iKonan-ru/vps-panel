import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field } from '@/components/ui/field';
import { InfoTip } from '@/components/ui/info-tip';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { actions } from '@/lib/actions';
import { useAction } from '@/lib/use-action';
import type { PortsyncConfig, RuleInput } from '@vps/protocol';
import { type FormEvent, useEffect, useState } from 'react';

export function RuleDialog({
  serverId,
  open,
  onClose,
  onSaved,
}: { serverId: string; open: boolean; onClose: () => void; onSaved: () => unknown }) {
  const [f, setF] = useState({
    port: '',
    proto: 'tcp' as RuleInput['proto'],
    source: '',
    action: 'allow' as RuleInput['action'],
    comment: '',
  });
  const save = useAction();
  async function submit(e: FormEvent) {
    e.preventDefault();
    const m = /^(\d+)(?:\s*[-:]\s*(\d+))?$/.exec(f.port.trim());
    if (!m) return save.setError('Порт: число или диапазон, например 56000-56003');
    await save.run(async () => {
      const rule: RuleInput = {
        portFrom: Number(m[1]),
        proto: f.proto,
        source: f.source.trim() || 'any',
        action: f.action,
        comment: f.comment.trim(),
      };
      if (m[2]) rule.portTo = Number(m[2]);
      await actions.ruleAdd(serverId, rule);
      await onSaved();
      setF({ port: '', proto: 'tcp', source: '', action: 'allow', comment: '' });
      onClose();
    });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Новое правило">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Порт или диапазон" htmlFor="r-port">
            <Input
              id="r-port"
              value={f.port}
              onChange={(e) => setF({ ...f, port: e.target.value })}
              placeholder="5432 или 56000-56003"
              required
            />
          </Field>
          <Field label="Протокол" htmlFor="r-proto">
            <Select
              id="r-proto"
              value={f.proto}
              onChange={(e) => setF({ ...f, proto: e.target.value as RuleInput['proto'] })}
            >
              <option value="tcp">tcp</option>
              <option value="udp">udp</option>
              <option value="any">tcp и udp</option>
            </Select>
          </Field>
          <Field label="Источник" htmlFor="r-src">
            <Input
              id="r-src"
              value={f.source}
              onChange={(e) => setF({ ...f, source: e.target.value })}
              placeholder="любой"
            />
          </Field>
          <Field label="Действие" htmlFor="r-act">
            <Select
              id="r-act"
              value={f.action}
              onChange={(e) => setF({ ...f, action: e.target.value as RuleInput['action'] })}
            >
              <option value="allow">разрешить (allow)</option>
              <option value="deny">запретить (deny)</option>
            </Select>
          </Field>
        </div>
        <Field label="Комментарий" htmlFor="r-comment">
          <Input
            id="r-comment"
            value={f.comment}
            onChange={(e) => setF({ ...f, comment: e.target.value })}
          />
        </Field>
        {save.error && <Alert tone="bad">{save.error}</Alert>}
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Отмена</Button>
          <Button type="submit" variant="primary" disabled={save.busy}>
            Добавить
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

const lines = (v: string[]) => v.join('\n');

const parseLines = (v: string) =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter(Boolean);

export function PortsyncDialog({
  serverId,
  open,
  onClose,
  onSaved,
}: { serverId: string; open: boolean; onClose: () => void; onSaved: () => unknown }) {
  const [cfg, setCfg] = useState<PortsyncConfig | null>(null);
  const [f, setF] = useState({ admin: '', deny: '', extra: '', known: '' });
  const [error, setError] = useState<string | null>(null);
  const save = useAction();
  useEffect(() => {
    if (!open) return;
    setCfg(null);
    setError(null);
    actions
      .portsyncGet(serverId)
      .then((c) => {
        setCfg(c);
        setF({
          admin: lines(c.admin_ips),
          deny: lines(c.deny_public_ports),
          extra: lines(c.extra_allow),
          known: lines(c.known_processes),
        });
      })
      .catch((e: Error) => setError(e.message));
  }, [open, serverId]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!cfg) return;
    await save.run(async () => {
      await actions.portsyncPut(serverId, {
        ...cfg,
        admin_ips: parseLines(f.admin),
        deny_public_ports: parseLines(f.deny),
        extra_allow: parseLines(f.extra),
        known_processes: parseLines(f.known),
      });
      await onSaved();
      onClose();
    });
  }
  return (
    <Dialog open={open} onClose={onClose} title="Настройки port-sync" wide>
      {!cfg && !error && <div className="text-sm text-muted">Загрузка&hellip;</div>}
      {(error ?? save.error) && <Alert tone="bad">{error ?? save.error}</Alert>}
      {cfg && (
        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex items-center gap-1 text-[13px] text-muted">
            По одному значению в строке
            <InfoTip>
              Порты SSH, 3X-UI, MTProxyL, WireGuard и опубликованные порты контейнеров port-sync
              открывает сам
            </InfoTip>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Известные процессы" htmlFor="p-known" hint="их порты открываются">
              <Textarea
                id="p-known"
                value={f.known}
                onChange={(e) => setF({ ...f, known: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
            <Field
              label="Закрытые снаружи порты"
              htmlFor="p-deny"
              hint="даже для известных процессов"
            >
              <Textarea
                id="p-deny"
                value={f.deny}
                onChange={(e) => setF({ ...f, deny: e.target.value })}
                placeholder="9090/tcp"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="Всегда открытые порты" htmlFor="p-extra">
              <Textarea
                id="p-extra"
                value={f.extra}
                onChange={(e) => setF({ ...f, extra: e.target.value })}
                placeholder="8443/tcp"
                className="font-mono text-xs"
              />
            </Field>
            <Field label="IP администратора" htmlFor="p-admin" hint="доступ к служебным портам">
              <Textarea
                id="p-admin"
                value={f.admin}
                onChange={(e) => setF({ ...f, admin: e.target.value })}
                className="font-mono text-xs"
              />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Порты контейнеров" htmlFor="p-docker">
              <Select
                id="p-docker"
                value={cfg.docker_policy}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    docker_policy: e.target.value as PortsyncConfig['docker_policy'],
                  })
                }
              >
                <option value="published">опубликованные (-p) открываются автоматически</option>
                <option value="explicit">только из &laquo;Всегда открытые порты&raquo;</option>
              </Select>
            </Field>
            <Field label="Ping" htmlFor="p-ping">
              <Select
                id="p-ping"
                value={cfg.allow_ping ? '1' : '0'}
                onChange={(e) => setCfg({ ...cfg, allow_ping: e.target.value === '1' })}
              >
                <option value="1">разрешить</option>
                <option value="0">запретить</option>
              </Select>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <Button onClick={onClose}>Отмена</Button>
            <Button type="submit" variant="primary" disabled={save.busy}>
              Сохранить и применить
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
