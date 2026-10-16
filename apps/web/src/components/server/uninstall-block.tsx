import { Button } from '@/components/ui/button';
import { Section } from '@/components/ui/section';
import { useUninstall } from '@/lib/uninstall';
import { Trash2 } from 'lucide-react';

/** Блок "Удаление" вкладки сервиса: кнопка ведёт в команду удаления и сама ничего не удаляет. */
export function UninstallBlock({
  serverId,
  kind,
  title,
  loses,
  disabled,
  reason,
}: {
  serverId: string;
  /** Вид сервиса из инвентаря. */
  kind: string;
  title: string;
  /** Что пропадёт с удалением. */
  loses: string;
  disabled?: boolean;
  reason?: string | undefined;
}) {
  const go = useUninstall();
  return (
    <Section title="Удаление">
      <div className="flex flex-col gap-3 px-4 py-3 md:flex-row md:items-center">
        <div className="min-w-0 grow text-[13px] text-muted">{loses}</div>
        <Button
          size="sm"
          variant="danger"
          className="shrink-0 self-start md:self-auto"
          disabled={disabled}
          title={reason}
          onClick={() => go(serverId, kind)}
        >
          <Trash2 className="size-3.5" />
          Удалить {title}
        </Button>
      </div>
    </Section>
  );
}
