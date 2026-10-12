import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { useConfirm } from '@/components/ui/confirm';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { ago } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Power, RefreshCw } from 'lucide-react';
import { type FormEvent, useState } from 'react';

interface FirefoxView {
  keySet: boolean;
  id: string;
  version: string | null;
  signed: string | null;
  busy: boolean;
  error: string | null;
  at: string | null;
}

const KEY = ['firefox-settings'];

/**
 * Расширение Firefox: Mozilla подписывает его ключом API этой панели (addons.mozilla.org,
 * unlisted), новая версия после обновления панели подписывается сама.
 */
export function FirefoxSettings() {
  const ask = useConfirm();
  const qc = useQueryClient();
  const { data: st } = useQuery({
    queryKey: KEY,
    queryFn: () => api<FirefoxView>('/api/settings/firefox'),
    refetchInterval: (q) => (q.state.data?.busy ? 5000 : 60_000),
  });
  const [issuer, setIssuer] = useState('');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (!st) return null;

  const run = async (fn: () => Promise<FirefoxView>) => {
    setBusy(true);
    setErr(null);
    try {
      qc.setQueryData(KEY, await fn());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const save = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const v = await api<FirefoxView>('/api/settings/firefox', {
        method: 'PUT',
        json: { issuer: issuer.trim(), secret: secret.trim() },
      });
      setIssuer('');
      setSecret('');
      return v;
    });
  };
  const remove = async () => {
    if (
      !(await ask({
        title: 'Удалить ключ Mozilla?',
        text: 'Новые версии расширения не будут подписываться.',
        okLabel: 'Удалить',
        danger: true,
      }))
    )
      return;
    await run(() => api('/api/settings/firefox', { method: 'DELETE' }));
  };
  const fresh = st.signed !== null && st.signed === st.version;

  return (
    <Section
      title="Расширение Firefox"
      info={
        'Firefox устанавливает только расширения, подписанные Mozilla. Ключ выдаётся на addons.mozilla.org: Tools\u00a0\u2192 Manage API Keys. Без ключа на личных страницах доступно только расширение для Chrome'
      }
      extra={
        <>
          {st.busy ? (
            <Chip tone="accent">подписывается</Chip>
          ) : fresh ? (
            <Chip tone="ok">подписано {st.signed}</Chip>
          ) : st.keySet ? (
            <Chip tone="warn">
              {st.signed ? `подписано ${st.signed}, доступна ${st.version}` : 'не подписано'}
            </Chip>
          ) : (
            <Chip>ключ не задан</Chip>
          )}
          {st.at && <span className="text-xs text-muted">{ago(st.at)}</span>}
        </>
      }
      actions={
        st.keySet ? (
          <>
            <Button
              size="sm"
              disabled={busy || st.busy}
              onClick={() => run(() => api('/api/settings/firefox/sign', { method: 'POST' }))}
              label="Подписать"
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || st.busy}
              onClick={remove}
              label="Удалить ключ"
            >
              <Power className="size-3.5" />
            </Button>
          </>
        ) : null
      }
    >
      <form onSubmit={save} className="flex flex-col gap-3 p-4">
        <div className="text-xs text-muted">
          ID расширения: <span className="font-mono">{st.id}</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="JWT issuer" htmlFor="ff-issuer">
            <Input
              id="ff-issuer"
              autoComplete="off"
              value={issuer}
              onChange={(e) => setIssuer(e.target.value)}
              placeholder={st.keySet ? 'задан' : 'user:12345:678'}
            />
          </Field>
          <Field label="JWT secret" htmlFor="ff-secret">
            <Input
              id="ff-secret"
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
            />
          </Field>
        </div>
        {st.error && <Alert tone="bad">Подпись: {st.error}</Alert>}
        {err && <Alert tone="bad">{err}</Alert>}
        <div className="flex justify-end">
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !issuer.trim() || !secret.trim()}
          >
            Сохранить ключ
          </Button>
        </div>
      </form>
    </Section>
  );
}
