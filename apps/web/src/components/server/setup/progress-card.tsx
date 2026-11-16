import { ActionOutput } from '@/components/action-output';
import { Button, ButtonLink } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Chip } from '@/components/ui/chip';
import { dateTime } from '@/lib/format';
import type { SetupProgress, SetupStepState } from '@vps/protocol';
import { ArrowRight, ChevronDown, RotateCcw } from 'lucide-react';
import { useState } from 'react';

const STATE: Record<
  SetupStepState,
  { text: string; tone: 'ok' | 'warn' | 'bad' | 'muted' | 'accent' }
> = {
  pending: { text: 'ждёт', tone: 'muted' },
  running: { text: 'выполняется', tone: 'accent' },
  done: { text: 'готово', tone: 'ok' },
  skipped: { text: 'пропущен', tone: 'muted' },
  failed: { text: 'ошибка', tone: 'bad' },
};

/**
 * Ход последней настройки: итог (выполняется, завершена, остановилась на ошибке), шаги, вывод,
 * продолжение с упавшего шага и переход к серверу после успешной.
 */
export function ProgressCard({
  serverId,
  progress,
  disabled,
  title,
  onContinue,
}: {
  serverId: string;
  progress: SetupProgress;
  /** Продолжить нельзя (идёт действие, не заполнены пароли...). */
  disabled: boolean;
  /** Почему нельзя; иначе подсказка кнопки - с какого шага. */
  title: string | undefined;
  onContinue: (fromStep: string) => void;
}) {
  const [showOutput, setShowOutput] = useState(false);
  const running = !progress.finishedAt;
  const failed = progress.finishedAt ? progress.steps.find((x) => x.state === 'failed') : undefined;
  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="font-semibold">
          {running
            ? 'Настройка выполняется'
            : failed
              ? 'Настройка остановилась на ошибке'
              : 'Настройка завершена'}
        </div>
        {running ? (
          <Chip tone="accent" dot pulse>
            выполняется
          </Chip>
        ) : failed ? (
          <Chip tone="bad">ошибка</Chip>
        ) : (
          <Chip tone="ok">готово</Chip>
        )}
        <span className="text-xs text-muted">
          {progress.finishedAt ? (
            <>
              {dateTime(progress.startedAt)}&nbsp;&ndash; {dateTime(progress.finishedAt)}
            </>
          ) : (
            `с ${dateTime(progress.startedAt)}`
          )}
        </span>
        <div className="grow" />
        {progress.finishedAt && !failed && (
          <ButtonLink to="/servers/$id" params={{ id: serverId }} size="sm" variant="primary">
            Перейти к серверу
            <ArrowRight className="size-3.5" />
          </ButtonLink>
        )}
        {failed && (
          <Button
            size="sm"
            variant="primary"
            disabled={disabled}
            title={title ?? `Продолжить с шага \u00ab${failed.title}\u00bb`}
            onClick={() => onContinue(failed.id)}
          >
            <RotateCcw className="size-3.5" />
            {/* на узком экране название шага не помещается: упавший шаг виден в списке */}
            Продолжить
            <span className="max-sm:hidden">с шага &laquo;{failed.title}&raquo;</span>
          </Button>
        )}
      </div>
      <div className="flex flex-col gap-1.5 text-[13px]">
        {progress.steps.map((x) => (
          <div key={x.id} className="flex items-start gap-2">
            <Chip
              tone={STATE[x.state].tone}
              dot={x.state === 'running'}
              pulse={x.state === 'running'}
            >
              {STATE[x.state].text}
            </Chip>
            <div className="min-w-0">
              <div>{x.title}</div>
              {x.note && (
                <div className={x.state === 'failed' ? 'text-xs text-bad' : 'text-xs text-muted'}>
                  {x.note}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      {running || showOutput ? (
        <ActionOutput actionId={progress.actionId} />
      ) : (
        <button
          type="button"
          className="inline-flex w-fit items-center gap-1 text-xs text-accent"
          onClick={() => setShowOutput(true)}
        >
          <ChevronDown className="size-3.5" />
          Показать вывод
        </button>
      )}
    </Card>
  );
}
