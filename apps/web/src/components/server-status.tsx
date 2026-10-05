import { Chip } from '@/components/ui/chip';
import { cn } from '@/lib/cn';
import { ago } from '@/lib/format';
import type { ServerSummary } from '@vps/protocol';

type Tone = 'ok' | 'warn' | 'bad' | 'muted';

const dots: Record<Tone, string> = {
  ok: 'bg-ok',
  warn: 'bg-warn',
  bad: 'bg-bad',
  muted: 'bg-muted',
};

function describe(s: ServerSummary): { tone: Tone; text: string } {
  if (s.status === 'online') return { tone: 'ok', text: 'в сети' };
  if (s.status === 'rebooting') return { tone: 'warn', text: 'перезагрузка' };
  if (s.status === 'offline') return { tone: 'bad', text: `не в сети ${ago(s.lastSeenAt)}` };
  return { tone: 'muted', text: 'нет агента' };
}

/** Состояние сервера чипом с текстом; dotOnly - только цветная точка, текст в подсказке. */
export function ServerStatusChip({ s, dotOnly }: { s: ServerSummary; dotOnly?: boolean }) {
  const { tone, text } = describe(s);
  if (dotOnly)
    return (
      <span
        role="img"
        title={text}
        aria-label={text}
        className={cn(
          'size-2.5 shrink-0 rounded-full transition-colors duration-300',
          dots[tone],
          s.status === 'rebooting' && 'animate-pulse',
        )}
      />
    );
  return (
    <Chip tone={tone} dot pulse={s.status === 'rebooting'}>
      {text}
    </Chip>
  );
}
