import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordInput } from '@/components/ui/password-input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/cn';
import type { CommandParam } from '@/lib/commands';
import { clampInt, digitsOnly } from '@/lib/masks';
import { useEffect } from 'react';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

/** Случайный пароль из 20 букв и цифр (без похожих: 0/O, 1/l/I) - криптостойкий генератор. */
export function randomPassword(length = 20): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export function ParamField({
  p,
  value,
  onChange,
  awgContainers,
  idPrefix,
  generate,
}: {
  p: CommandParam;
  value: string;
  onChange: (v: string) => void;
  awgContainers: { name: string; label: string }[];
  /** Несколько форм команд на одной странице (настройка сервера): id полей не совпадают. */
  idPrefix?: string;
  /** У обязательного пароля - кнопка случайного пароля. */
  generate?: boolean;
}) {
  // сохранённый ответ мог указывать на контейнер, которого уже нет: берём первый из стоящих
  const awgFirst = awgContainers[0]?.name;
  const awgValid = awgContainers.some((c) => c.name === value);
  useEffect(() => {
    if (p.type === 'awg-container' && !awgValid && awgFirst) onChange(awgFirst);
  }, [p.type, awgValid, awgFirst, onChange]);
  const id = idPrefix ? `p-${idPrefix}-${p.name}` : `p-${p.name}`;
  const wide =
    p.type === 'text' ||
    (p.type === 'select' && (p.options?.some((o) => o.label.length > 40) ?? false));
  let control: React.ReactNode;
  if (p.type === 'awg-container') {
    control = (
      <Select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
        {awgContainers.length === 0 && <option value="">на сервере нет контейнеров AWG</option>}
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
        onGenerate={generate && p.required ? () => onChange(randomPassword()) : undefined}
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
