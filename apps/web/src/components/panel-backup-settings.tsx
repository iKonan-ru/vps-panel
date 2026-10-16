import { Alert } from '@/components/ui/alert';
import { Button, buttonClass } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Send } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface PanelBackupStatus {
  passwordSet: boolean;
  telegram: boolean;
  last: {
    at: string;
    to: 'telegram' | 'download';
    ok: boolean;
    size?: number;
    error?: string;
  } | null;
  decryptHint: string;
}

/** Копия самой панели под паролем: база, SESSION_SECRET и SSH-ключ; раз в сутки - в Telegram. */
export function PanelBackupSettings() {
  const qc = useQueryClient();
  const { data: st } = useQuery({
    queryKey: ['panel-backup'],
    queryFn: () => api<PanelBackupStatus>('/api/panel-backup'),
  });
  const [password, setPassword] = useState('');
  const op = useAction();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const note: { tone: 'ok' | 'bad'; text: string } | null = op.error
    ? { tone: 'bad', text: op.error }
    : msg;

  async function call(fn: () => Promise<unknown>, ok: string) {
    setMsg(null);
    await op.run(async () => {
      try {
        await fn();
        setMsg({ tone: 'ok', text: ok });
      } finally {
        // кнопки - только после свежего состояния (переключатель Telegram по старому значению)
        await qc.invalidateQueries({ queryKey: ['panel-backup'] });
      }
    });
  }

  if (!st) return null;
  const last = st.last;

  return (
    <Section
      title="Резервная копия панели"
      info={
        <>
          База панели, её ключи шифрования и SSH-ключ. Тем же паролем шифруются скачанные копии
          серверов. Восстановление:{' '}
          <span className="font-mono">vps-panel restore &lt;файл&gt;</span>. Расшифровка вручную:{' '}
          <span className="break-all font-mono">{st.decryptHint}</span>
        </>
      }
      extra={
        last &&
        (last.ok ? (
          <Chip tone="ok">
            {last.to === 'telegram' ? 'отправлена' : 'скачана'} {ago(last.at)}
          </Chip>
        ) : (
          <Chip tone="bad">ошибка {ago(last.at)}</Chip>
        ))
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <form
          className="flex flex-col gap-2"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void call(async () => {
              await api('/api/panel-backup/settings', { method: 'POST', json: { password } });
              setPassword('');
            }, 'Пароль сохранён');
          }}
        >
          <Field
            label={st.passwordSet ? 'Новый пароль' : 'Пароль'}
            htmlFor="pb-pass"
            hint={st.passwordSet ? 'действует для следующих копий' : 'не короче 8\u00a0символов'}
          >
            <div className="flex flex-wrap gap-2">
              <div className="min-w-0 grow basis-60">
                <PasswordInput
                  id="pb-pass"
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              <Button type="submit" disabled={op.busy || password.length < 8}>
                Сохранить
              </Button>
            </div>
          </Field>
        </form>
        <div className="flex items-center gap-3">
          <Switch
            checked={st.telegram}
            disabled={op.busy || !st.passwordSet}
            label="Ежедневная отправка в Telegram"
            onChange={() =>
              void call(
                () =>
                  api('/api/panel-backup/settings', {
                    method: 'POST',
                    json: { telegram: !st.telegram },
                  }),
                st.telegram ? 'Отправка выключена' : 'Отправка включена',
              )
            }
          />
          <span className="text-[13px]">Ежедневная отправка в Telegram</span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={op.busy || !st.passwordSet}
            onClick={() =>
              void call(async () => {
                const r = await api<{ ok: boolean; error?: string }>('/api/panel-backup/telegram', {
                  method: 'POST',
                });
                if (!r.ok) throw new Error(r.error ?? 'не отправлен');
              }, 'Отправлено')
            }
          >
            <Send className="size-4" />
            Отправить в Telegram
          </Button>
          {st.passwordSet ? (
            <a href="/api/panel-backup/download" download className={buttonClass()}>
              <Download className="size-4" />
              Скачать
            </a>
          ) : (
            <Button disabled>
              <Download className="size-4" />
              Скачать
            </Button>
          )}
        </div>
        {/* ответ только что нажатой кнопки важнее: одну и ту же ошибку дважды не показываем */}
        {!msg && last && !last.ok && last.error && (
          <Alert tone="bad">Последняя копия не создана: {last.error}</Alert>
        )}
        {last?.ok && last.size && (
          <div className="text-xs text-muted">Размер: {bytes(last.size)}</div>
        )}
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
      </div>
    </Section>
  );
}
