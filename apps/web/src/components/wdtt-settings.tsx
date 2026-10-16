import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field } from '@/components/ui/field';
import { Section } from '@/components/ui/section';
import { Textarea } from '@/components/ui/textarea';
import { api } from '@/lib/api';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type FormEvent, useEffect, useState } from 'react';

/** Хеш из строки: голый хеш или ссылка https://vk.com/call/join/<хеш>. */
const toHash = (s: string) => s.replace(/^.*\/call\/join\//, '').replace(/[?#].*$/, '');

/**
 * Хеши звонков VK для WDTT: общие для всех клиентов - уходят в ссылки и
 * подписку qWDTT. Пусто - клиенты добавляют свои хеши в приложении.
 */
export function WdttSettings() {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ['wdtt-settings'],
    queryFn: () => api<{ hashes: string[] }>('/api/settings/wdtt'),
  });
  const [text, setText] = useState('');
  const op = useAction();
  const [msg, setMsg] = useState<{ tone: 'ok' | 'bad'; text: string } | null>(null);
  const note: { tone: 'ok' | 'bad'; text: string } | null = op.error
    ? { tone: 'bad', text: op.error }
    : msg;
  useEffect(() => {
    if (data) setText(data.hashes.join('\n'));
  }, [data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setMsg(null);
    await op.run(async () => {
      const hashes = text
        .split(/[\s,]+/)
        .map(toHash)
        .filter(Boolean);
      await api('/api/settings/wdtt', { method: 'PUT', json: { hashes } });
      await qc.invalidateQueries({ queryKey: ['wdtt-settings'] });
      setMsg({
        tone: 'ok',
        text: 'Сохранено. Ссылки клиентов обновятся при синхронизации',
      });
    });
  }

  return (
    <Section
      title="WDTT: звонки VK"
      info="Ссылки на звонки VK получат все клиенты. Если список пуст, клиенты добавляют свои звонки в приложении"
    >
      <form className="flex flex-col gap-3 p-4" onSubmit={save}>
        <Field label="Ссылки или хеши звонков, по одному в строке" htmlFor="wdtt-hashes">
          <Textarea
            id="wdtt-hashes"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="https://vk.com/call/join/..."
            className="font-mono text-xs"
          />
        </Field>
        {note && <Alert tone={note.tone}>{note.text}</Alert>}
        <div className="flex justify-end">
          <Button type="submit" variant="primary" disabled={op.busy || !data}>
            Сохранить
          </Button>
        </div>
      </form>
    </Section>
  );
}
