import {
  FingerprintField,
  PortField,
  TargetField,
  type TargetOption,
  sameOptions,
  scanOptions,
  useRealityScan,
} from '@/components/server/xui-inbound-fields';
import type { Inbound } from '@/components/server/xui-inbounds';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

/** GET /xui/inbounds/:iid/edit: текущие значения (без ключей) и цели других inbound-ов. */
interface EditData {
  id: number;
  remark: string;
  port: number;
  kind: 'raw' | 'xhttp' | null;
  reality: { target: string; serverNames: string[]; fingerprint: string } | null;
  same: { id: number; remark: string; target: string; serverNames: string[] }[];
}

const KIND_TITLE = { raw: 'RAW (TCP, Reality, Vision)', xhttp: 'XHTTP (Reality)' };

/**
 * Окно правки inbound-а: те же поля, что при добавлении (порт, подпись, цель Reality,
 * fingerprint). Тип не меняется: другой транспорт - это новый inbound. У inbound-ов не VLESS
 * Reality - только порт и подпись. Сохранение - действие: при смене порта или Reality панель
 * проверяет Xray и при остановке возвращает inbound как был.
 */
export function EditInboundForm({
  serverId,
  inbound,
  disabled,
  onCancel,
  onStarted,
}: {
  serverId: string;
  inbound: Inbound;
  disabled: boolean;
  onCancel: () => void;
  onStarted: (actionId: string) => void;
}) {
  const data = useQuery({
    queryKey: ['xui-inbound-edit', serverId, inbound.id],
    queryFn: () => api<EditData>(`/api/servers/${serverId}/xui/inbounds/${inbound.id}/edit`),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  // скан - только по кнопке: по умолчанию цель остаётся прежней
  const [scanOn, setScanOn] = useState(false);
  const scan = useRealityScan(serverId, scanOn);
  const [remark, setRemark] = useState(inbound.remark);
  const [port, setPort] = useState(String(inbound.port));
  const [fp, setFp] = useState('');
  const [targetKey, setTargetKey] = useState('cur');
  const act = useAction();

  const d = data.data;
  useEffect(() => {
    if (!d) return;
    setRemark(d.remark);
    setPort(String(d.port));
    setFp(d.reality?.fingerprint ?? '');
  }, [d]);

  const options: TargetOption[] = d?.reality
    ? [
        {
          key: 'cur',
          label: `Сейчас: ${d.reality.target}`,
          target: d.reality.target,
          serverNames: d.reality.serverNames,
        },
        ...scanOptions(scan.data?.targets),
        ...sameOptions(d.same),
      ]
    : [];
  const key = options.some((o) => o.key === targetKey) ? targetKey : 'cur';
  const chosen = options.find((o) => o.key === key);

  const n = Number(port);
  const badPort = !Number.isInteger(n) || n < 1 || n > 65535;
  const body: Record<string, unknown> = {};
  if (d && remark.trim() && remark.trim() !== d.remark) body.remark = remark.trim();
  if (d && !badPort && n !== d.port) body.port = n;
  if (d?.reality && chosen && key !== 'cur') {
    body.target = chosen.target;
    body.serverNames = chosen.serverNames;
  }
  if (d?.reality && fp && fp !== d.reality.fingerprint) body.fingerprint = fp;
  const changed = Object.keys(body).length > 0;
  const risky = 'port' in body || 'target' in body || 'fingerprint' in body;
  const ready =
    !disabled && !act.busy && !data.isFetching && !scan.isFetching && Boolean(d) && changed;
  const valid = !badPort && Boolean(remark.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !valid) return;
    void act.run(async () => {
      const r = await api<{ actionId: string }>(
        `/api/servers/${serverId}/xui/inbounds/${inbound.id}/edit`,
        { method: 'POST', json: body },
      );
      onStarted(r.actionId);
    });
  };

  if (data.error) return <Alert tone="bad">{data.error.message}</Alert>;
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {d?.kind && (
        <div className="text-[13px]">
          <span className="text-muted">Тип: </span>
          {KIND_TITLE[d.kind]}
          <span className="block text-xs text-muted">
            другой тип&nbsp;&mdash; новым inbound, этот затем можно удалить
          </span>
        </div>
      )}
      <div className="grid grid-cols-[9.5rem_1fr] gap-2">
        <PortField
          id="edit-port"
          serverId={serverId}
          value={port}
          onChange={setPort}
          disabled={!d || act.busy}
          avoid={[]}
        />
        <Field label="Подпись" htmlFor="edit-remark">
          <Input
            id="edit-remark"
            value={remark}
            maxLength={100}
            disabled={!d || act.busy}
            onChange={(e) => setRemark(e.target.value)}
          />
        </Field>
      </div>

      {d?.reality && (
        <>
          <TargetField
            options={options}
            value={key}
            onChange={setTargetKey}
            scanning={scan.isFetching}
            scanError={scan.error}
            onRescan={() => (scanOn ? void scan.refetch() : setScanOn(true))}
            disabled={act.busy}
            rescanTitle="Подобрать цель с сервера"
          />
          <FingerprintField value={fp} onChange={setFp} disabled={act.busy} />
        </>
      )}
      {d && !d.reality && (
        <div className="text-xs text-muted">
          Не VLESS Reality: здесь меняются порт и подпись, остальное&nbsp;&mdash; в панели 3X-UI
        </div>
      )}

      {act.error && <Alert tone="bad">{act.error}</Alert>}
      {risky && (
        <div className="text-xs text-muted">
          Около 30&nbsp;с: панель проверяет, что Xray работает, и при остановке возвращает inbound
          как был. Подписки получат новые ссылки сами, клиентам без подписки нужна новая ссылка.
          {inbound.telegramExit ? ' Выход в Telegram через этот inbound обновится сам.' : ''}
        </div>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={act.busy}>
          Отмена
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || !valid}>
          Сохранить
        </Button>
      </div>
    </form>
  );
}
