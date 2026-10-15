import {
  FingerprintField,
  PortField,
  TargetField,
  sameOptions,
  scanOptions,
  useRealityScan,
} from '@/components/server/xui-inbound-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

type Kind = 'raw' | 'xhttp';

/** GET /xui/inbound-new: свободные порты, подписи, цели стоящих inbound-ов. */
interface NewDefaults {
  raw: { port: number; remark: string };
  xhttp: { port: number; remark: string; note: string | null };
  same: { id: number; remark: string; target: string; serverNames: string[] }[];
  fingerprint: string;
}

const KINDS: { kind: Kind; title: string; hint: string }[] = [
  { kind: 'raw', title: 'RAW', hint: 'TCP, Reality, Vision' },
  { kind: 'xhttp', title: 'XHTTP', hint: 'XHTTP, Reality' },
];

/**
 * Окно "Добавить соединения VLESS": RAW и/или XHTTP с Reality. Цель Reality - скан 3X-UI с
 * самого сервера (лучшая по задержке выбрана) или цель уже стоящего inbound-а. Ключи и
 * остальное панель заполняет сама; запуск - действие, ход виден в блоке.
 */
export function NewInboundsForm({
  serverId,
  disabled,
  onCancel,
  onStarted,
}: {
  serverId: string;
  disabled: boolean;
  onCancel: () => void;
  onStarted: (actionId: string) => void;
}) {
  const defaults = useQuery({
    queryKey: ['xui-inbound-new', serverId],
    queryFn: () => api<NewDefaults>(`/api/servers/${serverId}/xui/inbound-new`),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const scan = useRealityScan(serverId, true);
  const [on, setOn] = useState<Record<Kind, boolean>>({ raw: true, xhttp: true });
  const [port, setPort] = useState<Record<Kind, string>>({ raw: '', xhttp: '' });
  const [remark, setRemark] = useState<Record<Kind, string>>({ raw: '', xhttp: '' });
  const [fp, setFp] = useState('firefox');
  const [targetKey, setTargetKey] = useState('');
  const act = useAction();

  // значения с сервера - один раз, когда пришли
  const d = defaults.data;
  useEffect(() => {
    if (!d) return;
    setPort({ raw: String(d.raw.port), xhttp: String(d.xhttp.port) });
    setRemark({ raw: d.raw.remark, xhttp: d.xhttp.remark });
    if (d.fingerprint) setFp(d.fingerprint);
  }, [d]);

  const options = [...scanOptions(scan.data?.targets), ...sameOptions(d?.same)];
  // выбор по умолчанию - лучшая цель скана (или первая из стоящих, пока скан идёт или не удался)
  const key = options.some((o) => o.key === targetKey) ? targetKey : (options[0]?.key ?? '');
  const chosen = options.find((o) => o.key === key);

  const kinds = KINDS.filter((k) => on[k.kind]);
  const portOf = (k: Kind) => Number(port[k]);
  const badPort = kinds.some((k) => {
    const n = portOf(k.kind);
    return !Number.isInteger(n) || n < 1 || n > 65535;
  });
  const samePorts = kinds.length === 2 && portOf('raw') === portOf('xhttp');
  const noRemark = kinds.some((k) => !remark[k.kind].trim());
  const loading = defaults.isFetching || scan.isFetching;
  const ready =
    !disabled && !act.busy && !loading && Boolean(d) && kinds.length > 0 && Boolean(chosen);
  const valid = !badPort && !samePorts && !noRemark;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!ready || !valid || !chosen) return;
    void act.run(async () => {
      const r = await api<{ actionId: string }>(`/api/servers/${serverId}/xui/inbounds/new`, {
        method: 'POST',
        json: {
          items: kinds.map((k) => ({
            kind: k.kind,
            port: portOf(k.kind),
            remark: remark[k.kind].trim(),
          })),
          target: chosen.target,
          serverNames: chosen.serverNames,
          fingerprint: fp,
        },
      });
      onStarted(r.actionId);
    });
  };

  if (defaults.error) return <Alert tone="bad">{defaults.error.message}</Alert>;
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {KINDS.map((k) => (
        <div key={k.kind} className="flex flex-col gap-2">
          <Checkbox
            label={k.title}
            hint={k.hint}
            checked={on[k.kind]}
            disabled={act.busy}
            onChange={(e) => setOn({ ...on, [k.kind]: e.target.checked })}
          />
          {on[k.kind] && (
            <div className="grid grid-cols-[9.5rem_1fr] gap-2 pl-6.5">
              <PortField
                id={`new-${k.kind}-port`}
                serverId={serverId}
                value={port[k.kind]}
                onChange={(v) => setPort((p) => ({ ...p, [k.kind]: v }))}
                disabled={!d || act.busy}
                avoid={kinds.filter((x) => x.kind !== k.kind).map((x) => portOf(x.kind))}
              />
              <Field label="Подпись" htmlFor={`new-${k.kind}-remark`}>
                <Input
                  id={`new-${k.kind}-remark`}
                  value={remark[k.kind]}
                  maxLength={100}
                  disabled={!d || act.busy}
                  onChange={(e) => setRemark({ ...remark, [k.kind]: e.target.value })}
                />
              </Field>
              {k.kind === 'xhttp' && d?.xhttp.note && (
                <div className="col-span-2 text-xs text-warn">
                  {d.xhttp.note}, предложен другой порт
                </div>
              )}
            </div>
          )}
        </div>
      ))}

      <TargetField
        options={options}
        value={key}
        onChange={setTargetKey}
        scanning={scan.isFetching}
        scanError={scan.error}
        onRescan={() => void scan.refetch()}
        disabled={act.busy}
        rescanTitle="Подобрать заново"
      />
      <FingerprintField value={fp} onChange={setFp} disabled={act.busy} />

      {samePorts && <Alert tone="bad">У RAW и XHTTP одинаковый порт</Alert>}
      {act.error && <Alert tone="bad">{act.error}</Alert>}
      <div className="text-xs text-muted">
        На каждый тип около 30&nbsp;с: панель проверяет, что Xray работает. Клиенты панели добавятся
        сразу после этого.
      </div>
      <div className="flex justify-end gap-2">
        <Button onClick={onCancel} disabled={act.busy}>
          Отмена
        </Button>
        <Button type="submit" variant="primary" disabled={!ready || !valid}>
          Добавить
        </Button>
      </div>
    </form>
  );
}
