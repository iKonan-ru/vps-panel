import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { type FormEvent, useEffect, useState } from 'react';

type Kind = 'raw' | 'xhttp';

/** GET /xui/inbound-new: свободные порты, подписи, цели стоящих inbound-ов. */
interface NewDefaults {
  raw: { port: number; remark: string };
  xhttp: { port: number; remark: string; note: string | null };
  same: { id: number; remark: string; target: string; serverNames: string[] }[];
  fingerprint: string;
}
/** GET /xui/reality-scan: подходящие цели с сервера (без имён YouTube). */
interface ScanTarget {
  target: string;
  serverNames: string[];
  latencyMs: number;
  issuer: string;
}

const KINDS: { kind: Kind; title: string; hint: string }[] = [
  { kind: 'raw', title: 'RAW', hint: 'TCP, Reality, Vision' },
  { kind: 'xhttp', title: 'XHTTP', hint: 'XHTTP, Reality' },
];
const FINGERPRINTS = ['firefox', 'chrome', 'safari', 'edge', 'ios', 'android'];

/** Вариант цели в списке: из скана или "как у inbound". */
interface TargetOption {
  key: string;
  label: string;
  target: string;
  serverNames: string[];
}

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
  const scan = useQuery({
    queryKey: ['xui-reality-scan', serverId],
    queryFn: () => api<{ targets: ScanTarget[] }>(`/api/servers/${serverId}/xui/reality-scan`),
    staleTime: 5 * 60_000,
    retry: false,
  });
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
    if (FINGERPRINTS.includes(d.fingerprint)) setFp(d.fingerprint);
  }, [d]);

  const options: TargetOption[] = [
    ...(scan.data?.targets ?? []).map((t) => ({
      key: `scan:${t.target}`,
      label: `${t.target}, ${t.latencyMs}\u00a0мс`,
      target: t.target,
      serverNames: t.serverNames,
    })),
    ...(d?.same ?? []).map((s) => ({
      key: `same:${s.id}`,
      label: `Как у inbound \u00ab${s.remark || `#${s.id}`}\u00bb: ${s.target}`,
      target: s.target,
      serverNames: s.serverNames,
    })),
  ];
  // выбор по умолчанию - лучшая цель скана (или первая из стоящих, пока скан идёт или не удался)
  const key = options.some((o) => o.key === targetKey) ? targetKey : (options[0]?.key ?? '');
  const chosen = options.find((o) => o.key === key);
  const moreNames = Math.max(0, (chosen?.serverNames.length ?? 0) - 6);

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
            <div className="grid grid-cols-[7rem_1fr] gap-2 pl-6.5">
              <Field label="Порт" htmlFor={`new-${k.kind}-port`}>
                <Input
                  id={`new-${k.kind}-port`}
                  type="number"
                  min={1}
                  max={65535}
                  value={port[k.kind]}
                  disabled={!d || act.busy}
                  onChange={(e) => setPort({ ...port, [k.kind]: e.target.value })}
                  className="font-mono"
                />
              </Field>
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

      <Field
        label="Цель Reality"
        htmlFor="new-target"
        hint="Подобрана с сервера: TLS 1.3, h2, X25519 и сертификат проверены, имена YouTube не используются"
      >
        <div className="flex gap-2">
          <Select
            id="new-target"
            className="min-w-0 grow"
            value={key}
            disabled={!options.length || act.busy}
            onChange={(e) => setTargetKey(e.target.value)}
          >
            {!options.length && (
              <option value="">{scan.isFetching ? 'Подбор цели\u2026' : 'Нет подходящих'}</option>
            )}
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button
            size="icon"
            title="Подобрать заново"
            aria-label="Подобрать заново"
            disabled={scan.isFetching || act.busy}
            onClick={() => void scan.refetch()}
          >
            <RefreshCw className={scan.isFetching ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        </div>
      </Field>
      {scan.isFetching && !scan.data && (
        <div className="-mt-2 text-xs text-muted">подбор цели с сервера, до 15&nbsp;с</div>
      )}
      {scan.error && <Alert tone="bad">Подобрать цель не удалось: {scan.error.message}</Alert>}
      {chosen && (
        <div className="-mt-2 text-xs text-muted">
          имена: {chosen.serverNames.slice(0, 6).join(', ')}
          {moreNames > 0 ? ` и ещё ${moreNames}` : ''}
        </div>
      )}

      <Field label="Fingerprint" htmlFor="new-fp">
        <Select id="new-fp" value={fp} disabled={act.busy} onChange={(e) => setFp(e.target.value)}>
          {FINGERPRINTS.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </Select>
      </Field>

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
