import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import { REALITY_PRESETS, type RealityPreset, type RealityRejected } from '@vps/protocol';
import { RefreshCw, Shuffle } from 'lucide-react';
import { useState } from 'react';

const FINGERPRINTS = ['firefox', 'chrome', 'safari', 'edge', 'ios', 'android'];

/** Подходящая цель с сервера (POST /xui/reality-scan, без имён YouTube). */
interface ScanTarget {
  target: string;
  serverNames: string[];
  latencyMs: number;
  issuer: string;
}

interface ScanResult {
  targets: ScanTarget[];
  rejected: RealityRejected[];
}

/** Вариант цели в списке: из скана, "как у inbound" или текущая. */
export interface TargetOption {
  key: string;
  label: string;
  target: string;
  serverNames: string[];
}

export const PRESET_TITLE: Record<RealityPreset, string> = {
  foreign: 'Зарубежные сайты',
  ru: 'Российские сайты',
  nearby: 'Адреса рядом с сервером',
};

const scanApi = (serverId: string, body: { preset?: RealityPreset; targets?: string[] }) =>
  api<ScanResult>(`/api/servers/${serverId}/xui/reality-scan`, { method: 'POST', json: body });

/**
 * Подбор цели Reality с сервера (~10-30 с): готовый список кандидатов (preset) и проверка своих
 * адресов - подошедшие идут в список первыми, отказы - с причинами.
 */
export function useRealityPicker(
  serverId: string,
  opts: { preset: RealityPreset; enabled: boolean },
) {
  const [preset, setPreset] = useState<RealityPreset>(opts.preset);
  const [on, setOn] = useState(opts.enabled);
  const scan = useQuery({
    queryKey: ['xui-reality-scan', serverId, preset],
    queryFn: () => scanApi(serverId, { preset }),
    staleTime: 5 * 60_000,
    retry: false,
    enabled: on,
  });
  const check = useAction();
  const [own, setOwn] = useState<ScanResult>({ targets: [], rejected: [] });
  const runOwn = (text: string) =>
    check.run(async () => {
      const targets = text
        .split(/[\s,;]+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (!targets.length) return;
      setOwn(await scanApi(serverId, { targets }));
    });
  const options: TargetOption[] = [
    ...own.targets.map((t) => ({
      key: `own:${t.target}`,
      label: `${t.target}, ${t.latencyMs}\u00a0мс (свой)`,
      target: t.target,
      serverNames: t.serverNames,
    })),
    ...scanOptions(scan.data?.targets),
  ];
  return {
    preset,
    setPreset: (p: RealityPreset) => {
      setPreset(p);
      setOn(true);
    },
    rescan: () => (on ? void scan.refetch() : setOn(true)),
    scan,
    check,
    own,
    runOwn,
    options,
    busy: scan.isFetching || check.busy,
  };
}

export type RealityPicker = ReturnType<typeof useRealityPicker>;

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

/** Порт с кнопкой случайного свободного; avoid - уже выбранные в окне; pick - есть ли кнопка. */
export function PortField({
  id,
  serverId,
  value,
  onChange,
  disabled,
  avoid,
  pick: canPick = true,
}: {
  id: string;
  serverId: string;
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  avoid: number[];
  pick?: boolean;
}) {
  const op = useAction();
  async function pick() {
    await op.run(async () => {
      const q = avoid.filter((p) => p > 0).join(',');
      const r = await api<{ port: number }>(
        `/api/servers/${serverId}/xui/free-port${q ? `?not=${q}` : ''}`,
      );
      onChange(String(r.port));
    });
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
          disabled={disabled || op.busy}
          onChange={(e) => onChange(e.target.value)}
          className="min-w-0 grow font-mono"
        />
        {canPick && (
          <Button
            size="icon"
            title="Случайный свободный порт"
            aria-label="Случайный свободный порт"
            disabled={disabled || op.busy}
            onClick={() => void pick()}
          >
            <Shuffle className="size-4" />
          </Button>
        )}
      </div>
      {op.error && <div className="mt-1 text-xs text-bad">{op.error}</div>}
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
  picker,
}: {
  /** Откуда подбирать и проверка своих адресов. */
  picker?: RealityPicker;
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
      {picker && (
        <Field label="Подбор цели" htmlFor="xui-target-preset">
          <Select
            id="xui-target-preset"
            value={picker.preset}
            disabled={disabled || picker.busy}
            onChange={(e) => picker.setPreset(e.target.value as RealityPreset)}
          >
            {REALITY_PRESETS.map((p) => (
              <option key={p} value={p}>
                {PRESET_TITLE[p]}
              </option>
            ))}
          </Select>
        </Field>
      )}
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
      {picker && <OwnTargets picker={picker} disabled={disabled} />}
    </>
  );
}

/** Свои адреса для Reality: проверка с сервера, подошедшие - в списке целей. */
function OwnTargets({ picker, disabled }: { picker: RealityPicker; disabled: boolean }) {
  const [text, setText] = useState('');
  const { own, check } = picker;
  return (
    <div className="-mt-1 flex flex-col gap-1.5">
      <div className="flex gap-1.5">
        <Input
          aria-label="Свои адреса для Reality"
          placeholder="example.com, 203.0.113.10:443"
          value={text}
          disabled={disabled || check.busy}
          onChange={(e) => setText(e.target.value)}
          className="min-w-0 grow text-xs"
        />
        <Button
          disabled={disabled || picker.busy || !text.trim()}
          onClick={() => void picker.runOwn(text)}
        >
          Проверить
        </Button>
      </div>
      {check.busy && <div className="text-xs text-muted">проверка с сервера, до 30&nbsp;с</div>}
      {check.error && <div className="text-xs text-bad">{check.error}</div>}
      {own.targets.length > 0 && (
        <div className="text-xs text-ok">
          подходят: {own.targets.map((t) => t.target).join(', ')}
        </div>
      )}
      {own.rejected.length > 0 && (
        <div className="text-xs text-muted">
          не подходят: {own.rejected.map((r) => `${r.target}\u00a0\u2014 ${r.reason}`).join('; ')}
        </div>
      )}
    </div>
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
