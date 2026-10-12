import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { QrCode } from '@/components/ui/qr-code';
import { codeMask } from '@/lib/masks';
import { type FormEvent, useState } from 'react';

export interface TotpSetup {
  totpUri: string;
  totpSecret: string;
  backupCodes: string[];
}

/** Резервные коды: два столбца моноширинным, показываются один раз. */
export function BackupCodes({ codes }: { codes: string[] }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-0.5 font-mono text-xs">
      {codes.map((c) => (
        <span key={c}>{c}</span>
      ))}
    </div>
  );
}

/**
 * Настройка 2FA: QR для приложения-аутентификатора, секрет вручную, резервные коды и первый код.
 * Первый вход после установки и перенастройка из раздела "Аккаунт".
 */
export function TotpEnroll({
  setup,
  onConfirm,
  label,
  busy,
  error,
}: {
  setup: TotpSetup;
  onConfirm: (code: string) => void;
  label: string;
  busy: boolean;
  error: string | null;
}) {
  const [code, setCode] = useState('');
  const [saved, setSaved] = useState(false);
  function submit(e: FormEvent) {
    e.preventDefault();
    onConfirm(code);
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div className="flex flex-col items-center gap-5">
        <QrCode text={setup.totpUri} alt="QR для аутентификатора" />
        <div className="flex min-w-0 flex-col gap-2 text-[13px]">
          <Label>Секрет для ручного ввода</Label>
          <code className="break-all font-mono text-xs">{setup.totpSecret}</code>
          <Label className="mt-2">Резервные коды (показываются один раз)</Label>
          <BackupCodes codes={setup.backupCodes} />
        </div>
      </div>
      <Checkbox
        checked={saved}
        onChange={(e) => setSaved(e.target.checked)}
        label="Резервные коды сохранены в надёжном месте"
      />
      <Field label="Код из приложения" htmlFor="enroll-code">
        <Input
          id="enroll-code"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder="000 000"
          className="h-12 text-center font-mono text-xl tracking-[.2em]"
          value={code}
          onChange={(e) => setCode(codeMask(e.target.value))}
          required
        />
      </Field>
      {error && <Alert tone="bad">{error}</Alert>}
      <Button
        type="submit"
        variant="primary"
        className="h-10.5 justify-center"
        disabled={busy || !saved}
      >
        {label}
      </Button>
    </form>
  );
}
