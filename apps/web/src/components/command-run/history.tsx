import { ActionStatusChip } from '@/components/actions-table';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Pager, usePaged } from '@/components/ui/pager';
import { TBody, THead, Table } from '@/components/ui/table';
import { type ActionRow, actions } from '@/lib/actions';
import { ago } from '@/lib/format';
import { useQuery } from '@tanstack/react-query';
import { FileText, List } from 'lucide-react';

export function History({
  serverId,
  commandId,
  showAll,
  onShowAll,
  onOpen,
}: {
  serverId: string;
  commandId: string;
  showAll: boolean;
  onShowAll: () => void;
  onOpen: (aid: string) => void;
}) {
  const { data } = useQuery({
    queryKey: ['actions', serverId],
    queryFn: () => actions.log(serverId),
    enabled: Boolean(serverId),
  });
  const rows = (data ?? []).filter((r: ActionRow) => showAll || r.kind === `command:${commandId}`);
  const paged = usePaged(rows);
  if (!serverId) return <Card className="p-8 text-muted">Выбери сервер на вкладке "Форма"</Card>;
  return (
    <Card className="shrink-0 overflow-hidden">
      <div className="flex items-center gap-2.5 border-b border-border px-4 py-3">
        <div className="font-semibold">
          {showAll ? 'Все команды на сервере' : 'Запуски этой команды'}
        </div>
        <div className="grow" />
        {!showAll && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onShowAll}
            label="Показать все команды"
            short="Все команды"
          >
            <List className="size-3.5" />
          </Button>
        )}
      </div>
      <Table>
        <THead>
          <tr>
            <th>Когда</th>
            <th>Команда</th>
            <th>Итог</th>
            <th />
          </tr>
        </THead>
        <TBody>
          {paged.items.map((r) => (
            <tr key={r.id}>
              <td className="whitespace-nowrap text-muted">{ago(r.startedAt)}</td>
              <td>{String((r.params as { title?: string }).title ?? r.kind)}</td>
              <td>
                <ActionStatusChip finishedAt={r.finishedAt} exitCode={r.exitCode} />
              </td>
              <td className="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => onOpen(r.id)}
                  label="Вывод"
                  short="Вывод"
                >
                  <FileText className="size-3.5" />
                </Button>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-center text-muted">
                Запусков не было
              </td>
            </tr>
          )}
        </TBody>
      </Table>
      <Pager {...paged} />
    </Card>
  );
}
