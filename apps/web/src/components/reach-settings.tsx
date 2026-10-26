import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Field } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Section } from '@/components/ui/section';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { type FormEvent, useState } from 'react';

/**
 * Токен Globalping (необязательно): запас на случай, когда кончилась квота сервера. Квота токена
 * одна на все серверы, поэтому проверки сначала идут без него.
 */
export function ReachSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['reach-settings'],
    queryFn: () => api<{ tokenSet: boolean }>('/api/reach/settings'),
  });
  const [token, setToken] = useState('');
  const op = useAction();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const note: { tone: 'ok' | 'bad'; text: string } | null = op.error
    ? { tone: 'bad', text: op.error }
    : msg;

  async function save(value: string, e?: FormEvent) {
    e?.preventDefault();
    setMsg(null);
    await op.run(async () => {
      await api('/api/reach/settings', { method: 'PUT', json: { token: value } });
      setToken('');
      await qc.invalidateQueries({ queryKey: ['reach-settings'] });
      setMsg({ tone: 'ok', text: value ? 'Токен сохранён' : 'Токен удалён' });
    });
  }

  return (
    <Section
      title="Доступность из России"
      info={
        'Проверки выполняются через Globalping с адреса каждого сервера: у каждого своя квота, 250\u00a0зондов в час. Бесплатный токен (dash.globalping.io)\u00a0\u2014 500\u00a0зондов в час на все серверы вместе: панель берёт его, только когда квоты сервера не хватило.'
      }
      extra={
        data && (
          <Chip tone={data.tokenSet ? 'ok' : 'muted'}>
            {data.tokenSet ? 'токен задан' : 'без токена'}
          </Chip>
        )
      }
    >
      {/* одной строкой и на телефоне: удаление там - значком */}
      <form className="flex items-end gap-2 p-4" onSubmit={(e) => void save(token.trim(), e)}>
        <Field label="Токен Globalping" htmlFor="gp-token" className="min-w-0 grow">
          <Input
            id="gp-token"
            type="password"
            autoComplete="off"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={data?.tokenSet ? 'задан' : 'необязательно'}
          />
        </Field>
        <Button type="submit" variant="primary" disabled={op.busy || !token.trim()}>
          Сохранить
        </Button>
        {data?.tokenSet && (
          <Button
            variant="ghost"
            disabled={op.busy}
            onClick={() => void save('')}
            label="Удалить"
            className="text-bad hover:text-bad"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </form>
      {note && (
        <div className="px-4 pb-4">
          <Alert tone={note.tone}>{note.text}</Alert>
        </div>
      )}
    </Section>
  );
}
