import { ActionOutput } from '@/components/action-output';
import { Button } from '@/components/ui/button';
import { Chip } from '@/components/ui/chip';
import { Dialog } from '@/components/ui/dialog';
import { Pager, usePaged } from '@/components/ui/pager';
import { Section } from '@/components/ui/section';
import { TBody, THead, Table } from '@/components/ui/table';
import { type ActionRow, actionName } from '@/lib/actions';
import { dateTime } from '@/lib/format';
import { Link } from '@tanstack/react-router';
import { FileText } from 'lucide-react';
import { useState } from 'react';

/** Итог действия: выполняется, успех или ошибка (с кодом - withCode). */
export function ActionStatusChip({
  finishedAt,
  exitCode,
  withCode,
}: { finishedAt: string | null; exitCode: number | null; withCode?: boolean }) {
  if (finishedAt === null)
    return (
      <Chip tone="accent" dot pulse>
        выполняется
      </Chip>
    );
  if (exitCode === 0) return <Chip tone="ok">успех</Chip>;
  return <Chip tone="bad">{withCode ? `ошибка (код ${exitCode})` : 'ошибка'}</Chip>;
}

/**
 * Журнал действий с окном вывода: вкладка сервера и общий журнал. serverNames - колонка
 * "Сервер" (общий журнал по всем серверам).
 */
export function ActionsTable({
  title,
  rows,
  serverNames,
}: { title: string; rows: ActionRow[]; serverNames?: Map<string, string> }) {
  const [open, setOpen] = useState<ActionRow | null>(null);
  const paged = usePaged(rows);
  return (
    <>
      <Section title={title} extra={<Chip>{rows.length}</Chip>}>
        <Table>
          <THead>
            <tr>
              <th>Когда</th>
              {serverNames && <th>Сервер</th>}
              <th>Действие</th>
              <th>Результат</th>
              <th />
            </tr>
          </THead>
          <TBody>
            {paged.items.map((r) => (
              <tr key={r.id}>
                <td className="whitespace-nowrap font-mono text-xs text-muted">
                  {dateTime(r.startedAt)}
                </td>
                {serverNames && (
                  <td>
                    {r.serverId && serverNames.has(r.serverId) ? (
                      <Link
                        to="/servers/$id"
                        params={{ id: r.serverId }}
                        className="hover:text-accent"
                      >
                        {serverNames.get(r.serverId)}
                      </Link>
                    ) : (
                      <span className="text-muted">удалён</span>
                    )}
                  </td>
                )}
                <td>{actionName(r)}</td>
                <td>
                  <ActionStatusChip finishedAt={r.finishedAt} exitCode={r.exitCode} />
                </td>
                <td className="text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setOpen(r)}
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
                <td colSpan={serverNames ? 5 : 4} className="py-4 text-center text-muted">
                  Действий пока не было
                </td>
              </tr>
            )}
          </TBody>
        </Table>
        <Pager {...paged} />
      </Section>
      <Dialog
        open={open !== null}
        onClose={() => setOpen(null)}
        title={open ? actionName(open) : ''}
        wide
      >
        {open && <ActionOutput actionId={open.id} />}
      </Dialog>
    </>
  );
}
