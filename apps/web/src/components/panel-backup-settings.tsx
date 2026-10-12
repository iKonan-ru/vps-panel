import { Alert } from '@/components/ui/alert';
import { Button, buttonClass } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { PasswordInput } from '@/components/ui/password-input';
import { Section } from '@/components/ui/section';
import { Switch } from '@/components/ui/switch';
import { api } from '@/lib/api';
import { ago, bytes } from '@/lib/format';
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

/**
 * Бэкап самой панели: база, SESSION_SECRET (ключ к зашифрованному в базе), SSH-ключ панели.
 * Шифруется паролем, раз в сутки уходит файлом в Telegram, по кнопке - сразу или скачиванием.
 */
export function PanelBackupSettings() {
  const qc = useQueryClient();
  const { data: st } = useQuery({
    queryKey: ['panel-backup'],
    queryFn: () => api<PanelBackupStatus>('/api/panel-backup'),
  });
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);

  async function call(fn: () => Promise<unknown>, ok: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'ok', text: ok });
    } catch (e) {
      setMsg({ tone: 'bad', text: (e as Error).message });
    } finally {
      // кнопки - только после свежего состояния (переключатель Telegram по старому значению)
      await qc.invalidateQueries({ queryKey: ['panel-backup'] });
      setBusy(false);
    }
  }

  if (!st) return null;
  const last = st.last;

  return (
    <Section
      title="Бэкап панели"
      info={
        <>
          В бэкапе база панели, SESSION_SECRET (без него зашифрованные в базе доступы и ключи
          клиентов не прочитать) и SSH-ключ панели; бэкапы серверов не входят. Файл шифруется
          паролем. Расшифровать на любой машине:{' '}
          <span className="break-all font-mono">{st.decryptHint}</span>. Порядок восстановления - в
          README.txt внутри архива.
        </>
      }
      extra={
        last &&
        (last.ok ? (
          <Chip tone="ok">
            {last.to === 'telegram' ? 'в Telegram' : 'скачан'} {ago(last.at)}
          </Chip>
        ) : (
          <Chip tone="bad">ошибка {ago(last.at)}</Chip>
        ))
      }
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="text-[13px] text-muted">
          Пароль храни отдельно (например, в менеджере паролей): без него бэкап не открыть.
        </div>
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
            label={st.passwordSet ? 'Новый пароль бэкапа' : 'Пароль бэкапа'}
            htmlFor="pb-pass"
            hint={
              st.passwordSet
                ? 'пароль задан; новый будет применяться к следующим бэкапам, старые открываются прежним'
                : 'не короче 8 символов'
            }
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
              <Button type="submit" disabled={busy || password.length < 8}>
                Сохранить
              </Button>
            </div>
          </Field>
        </form>
        <div className="flex items-center gap-3">
          <Switch
            checked={st.telegram}
            disabled={busy || !st.passwordSet}
            label="Раз в сутки отправлять в Telegram"
            onChange={() =>
              void call(
                () =>
                  api('/api/panel-backup/settings', {
                    method: 'POST',
                    json: { telegram: !st.telegram },
                  }),
                st.telegram ? 'Отправка выключена' : 'Бэкап будет уходить в Telegram раз в сутки',
              )
            }
          />
          <span className="text-[13px]">
            Раз в сутки отправлять файлом в чат с ботом (настройки Telegram выше)
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy || !st.passwordSet}
            onClick={() =>
              void call(async () => {
                const r = await api<{ ok: boolean; error?: string }>('/api/panel-backup/telegram', {
                  method: 'POST',
                });
                if (!r.ok) throw new Error(r.error ?? 'не отправлен');
              }, 'Бэкап отправлен в Telegram')
            }
          >
            <Send className="size-4" />
            Отправить в Telegram сейчас
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
          <Alert tone="bad">Последний бэкап не удался: {last.error}</Alert>
        )}
        {last?.ok && last.size && (
          <div className="text-xs text-muted">Последний бэкап: {bytes(last.size)}</div>
        )}
        {msg && <Alert tone={msg.tone}>{msg.text}</Alert>}
      </div>
    </Section>
  );
}
