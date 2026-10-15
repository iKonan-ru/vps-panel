import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useQuery } from '@tanstack/react-query';
import { RefreshCw, Shuffle } from 'lucide-react';
import { useState } from 'react';

/** Поля окон добавления и правки inbound-ов VLESS: порт, цель Reality, fingerprint. */

export const FINGERPRINTS = ['firefox', 'chrome', 'safari', 'edge', 'ios', 'android'];

/** GET /xui/reality-scan: подходящие цели с сервера (без имён YouTube). */
export interface ScanTarget {
  target: string;
  serverNames: string[];
  latencyMs: number;
  issuer: string;
}

/** Вариант цели в списке: из скана, "как у inbound" или текущая. */
export interface TargetOption {
  key: string;
  label: string;
  target: string;
  serverNames: string[];
}

/** Скан целей Reality с сервера (~10 с): в окне добавления - сразу, в окне правки - по кнопке. */
export function useRealityScan(serverId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['xui-reality-scan', serverId],
    queryFn: () => api<{ targets: ScanTarget[] }>(`/api/servers/${serverId}/xui/reality-scan`),
    staleTime: 5 * 60_000,
    retry: false,
    enabled,
  });
}

export function scanOptions(targets: ScanTarget[] | undefined): TargetOption[] {
  return (targets ?? []).map((t) => ({
    key: `scan:${t.target}`,
    label: `${t.target}, ${t.latencyMs}\u00a0мс`,
    target: t.target,
    serverNames: t.serverNames,
  }));
}

export function sameOptions(
  same: { id: number; remark: string; target: string; serverNames: string[] }[] | undefined,
): TargetOption[] {
  return (same ?? []).map((s) => ({
    key: `same:${s.id}`,
    label: `Как у inbound \u00ab${s.remark || `#${s.id}`}\u00bb: ${s.target}`,
    target: s.target,
    serverNames: s.serverNames,
  }));
}

/**
 * Порт с кнопкой "Случайный свободный порт": панель подбирает его по inbound-ам и процессам
 * сервера; avoid - порты, уже выбранные в окне.
 */
export function PortField({
  id,
  serverId,
  value,
  onChange,
  disabled,
  avoid,
}: {
  id: string;
  serverId: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  avoid: number[];
}) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function pick() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const q = avoid.filter((p) => p > 0).join(',');
      const r = await api<{ port: number }>(
        `/api/servers/${serverId}/xui/free-port${q ? `?not=${q}` : ''}`,
      );
      onChange(String(r.port));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Field label="Порт" htmlFor={id}>
      <div className="flex gap-1.5">
        <Input
          id={id}
          type="number"
          min={1}
          max={65535}
          value={value}
          disabled={disabled || busy}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 grow font-mono"
        />
        <Button
          size="icon"
          title="Случайный свободный порт"
          aria-label="Случайный свободный порт"
          disabled={disabled || busy}
          onClick={() => void pick()}
        >
          <Shuffle className="size-4" />
        </Button>
      </div>
      {err && <div className="mt-1 text-xs text-bad">{err}</div>}
    </Field>
  );
}

/** Цель Reality: список вариантов, "Подобрать заново" (скан с сервера), имена выбранной. */
export function TargetField({
  options,
  value,
  onChange,
  scanning,
  scanError,
  onRescan,
  disabled,
  rescanTitle,
}: {
  options: TargetOption[];
  value: string;
  onChange: (key: string) => void;
  scanning: boolean;
  scanError: Error | null;
  onRescan: () => void;
  disabled: boolean;
  rescanTitle: string;
}) {
  const chosen = options.find((o) => o.key === value);
  const more = Math.max(0, (chosen?.serverNames.length ?? 0) - 6);
  return (
    <>
      <Field
        label="Цель Reality"
        htmlFor="xui-target"
        hint="Подбор с сервера: TLS 1.3, h2, X25519 и сертификат проверены, имена YouTube не используются"
      >
        <div className="flex gap-1.5">
          <Select
            id="xui-target"
            className="min-w-0 grow"
            value={value}
            disabled={!options.length || disabled}
            onChange={(e) => onChange(e.target.value)}
          >
            {!options.length && (
              <option value="">{scanning ? 'Подбор цели\u2026' : 'Нет подходящих'}</option>
            )}
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </Select>
          <Button
            size="icon"
            title={rescanTitle}
            aria-label={rescanTitle}
            disabled={scanning || disabled}
            onClick={onRescan}
          >
            <RefreshCw className={scanning ? 'size-4 animate-spin' : 'size-4'} />
          </Button>
        </div>
      </Field>
      {scanning && (
        <div className="-mt-2 text-xs text-muted">подбор цели с сервера, до 15&nbsp;с</div>
      )}
      {scanError && <Alert tone="bad">Подобрать цель не удалось: {scanError.message}</Alert>}
      {chosen && (
        <div className="-mt-2 text-xs text-muted">
          имена: {chosen.serverNames.slice(0, 6).join(', ')}
          {more > 0 ? ` и ещё ${more}` : ''}
        </div>
      )}
    </>
  );
}

export function FingerprintField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
}) {
  const list = FINGERPRINTS.includes(value) || !value ? FINGERPRINTS : [value, ...FINGERPRINTS];
  return (
    <Field label="Fingerprint" htmlFor="xui-fp">
      <Select
        id="xui-fp"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {list.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </Select>
    </Field>
  );
}
