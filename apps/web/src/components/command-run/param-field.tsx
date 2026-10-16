import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';
import { clampInt, digitsOnly } from '@/lib/masks';
import { randomToken } from '@/lib/random';
import type { CommandParamInfo } from '@vps/protocol';
import { useEffect } from 'react';

export function ParamField({
  p,
  value,
  onChange,
  awgContainers,
  idPrefix,
  generate,
}: {
  p: CommandParamInfo;
  value: string;
  onChange: (v: string) => void;
  awgContainers: { name: string; label: string }[];
  /** Несколько форм команд на одной странице (настройка сервера): id полей не совпадают. */
  idPrefix?: string;
  /** У обязательного пароля - кнопка случайного пароля. */
  generate?: boolean;
}) {
  // контейнер подставляется сам, только если он на сервере один: из нескольких выбирают руками
  // (по этому полю удаляют - "первый попавшийся" бывает основным контейнером с клиентами)
  const awgOnly = awgContainers.length === 1 ? awgContainers[0]?.name : undefined;
  const awgValid = awgContainers.some((c) => c.name === value);
  useEffect(() => {
    if (p.type !== 'awg-container' || awgValid) return;
    if (awgOnly) onChange(awgOnly);
    else if (value) onChange('');
  }, [p.type, awgValid, awgOnly, value, onChange]);
  const id = idPrefix ? `p-${idPrefix}-${p.name}` : `p-${p.name}`;
  const wide =
    p.type === 'text' ||
    (p.type === 'select' && (p.options?.some((o) => o.label.length > 40) ?? false));
  let control: React.ReactNode;
  if (p.type === 'awg-container') {
    control = (
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {awgContainers.length === 0 && <option value="">на сервере нет контейнеров AWG</option>}
        {awgContainers.length > 1 && !awgValid && (
          <option value="" disabled>
            выберите контейнер
          </option>
        )}
        {awgContainers.map((c) => (
          <option key={c.name} value={c.name}>
            {c.label}
          </option>
        ))}
      </Select>
    );
  } else if (p.type === 'select') {
    control = (
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {(p.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </Select>
    );
  } else if (p.type === 'text') {
    control = (
      <Textarea id={id} value={value} onChange={(e) => onChange(e.target.value)} rows={3} />
    );
  } else if (p.type === 'port') {
    control = (
      <Input
        id={id}
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(clampInt(e.target.value, 1, 65535))}
        required={p.required}
        className="font-mono"
      />
    );
  } else if (p.type === 'number') {
    control = (
      <Input
        id={id}
        value={value}
        inputMode="numeric"
        onChange={(e) => onChange(digitsOnly(e.target.value))}
        required={p.required}
        className="font-mono"
      />
    );
  } else if (p.type === 'password') {
    control = (
      <PasswordInput
        id={id}
        autoComplete="new-password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        required={p.required}
        onGenerate={generate && p.required ? () => onChange(randomToken()) : undefined}
      />
    );
  } else {
    control = (
      <Input
        id={id}
        autoComplete="off"
        value={value}
        onChange={(e) =>
          onChange(
            p.type === 'domain'
              ? e.target.value.toLowerCase().replace(/[^a-z0-9.-]/g, '')
              : e.target.value,
          )
        }
        required={p.required}
        className={p.type === 'domain' || p.type === 'string' ? 'font-mono' : ''}
      />
    );
  }
  return (
    <div className={cn('flex flex-col gap-1.5', wide && 'sm:col-span-2')}>
      <Label htmlFor={id}>
        {p.label}
        {p.required && <span className="text-bad"> *</span>}
      </Label>
      {control}
      {p.hint && <span className="text-xs text-muted">{p.hint}</span>}
    </div>
  );
}

/** Поля параметров команды по порядку: страница запуска команды и шаги настройки сервера. */
export function ParamFields({
  params,
  answers,
  onChange,
  awgContainers,
  idPrefix,
  generate,
}: {
  params: CommandParamInfo[];
  answers: Record<string, string>;
  onChange: (name: string, value: string) => void;
  awgContainers: { name: string; label: string }[];
  idPrefix?: string;
  generate?: boolean;
}) {
  return params.map((p) => (
    <ParamField
      key={p.name}
      p={p}
      value={answers[p.name] ?? ''}
      onChange={(v) => onChange(p.name, v)}
      awgContainers={awgContainers}
      {...(idPrefix ? { idPrefix } : {})}
      {...(generate ? { generate } : {})}
    />
  ));
}
