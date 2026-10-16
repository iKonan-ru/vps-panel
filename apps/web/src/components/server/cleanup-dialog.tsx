import { ActionOutput } from '@/components/action-output';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useAction } from '@/lib/use-action';
import { useQuery } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

interface CleanupItem {
  id: string;
  title: string;
  detail: string;
  bytes: number;
  safe: boolean;
}

/**
 * Очистка диска: агент считает, сколько занимает каждая категория мусора (кэш docker, apt,
 * старые логи, /tmp), безопасные отмечены сразу, остальные - по выбору. Ход в консоли.
 */
export function CleanupDialog({
  serverId,
  open,
  onClose,
}: { serverId: string; open: boolean; onClose: () => void }) {
  const scan = useQuery({
    queryKey: ['cleanup', serverId],
    queryFn: () => api<{ items: CleanupItem[] }>(`/api/servers/${serverId}/cleanup`),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const op = useAction();
  const { setError } = op;

  // по умолчанию отмечены безопасные категории
  useEffect(() => {
    if (scan.data && chosen === null) {
      setChosen(new Set(scan.data.items.filter((i) => i.safe).map((i) => i.id)));
    }
  }, [scan.data, chosen]);
  useEffect(() => {
    if (!open) {
      setChosen(null);
      setActionId(null);
      setError(null);
    }
  }, [open, setError]);

  const items = scan.data?.items ?? [];
  const total = items.filter((i) => chosen?.has(i.id)).reduce((a, i) => a + i.bytes, 0);
  const toggle = (id: string) =>
    setChosen((c) => {
      const n = new Set(c ?? []);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  async function run() {
    if (!chosen || chosen.size === 0) return;
    const ids = [...chosen];
    await op.run(async () => {
      const r = await api<{ actionId: string }>(`/api/servers/${serverId}/cleanup`, {
        method: 'POST',
        json: { ids },
      });
      setActionId(r.actionId);
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title="Очистка диска" wide>
      {actionId ? (
        <>
          <ActionOutput actionId={actionId} />
          <div className="flex justify-end">
            <Button onClick={onClose}>Закрыть</Button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[13px] text-muted">
            Данные сервисов (тома docker, конфиги, базы) не затрагиваются
          </div>
          {scan.isLoading && <div className="text-sm text-muted">Подсчёт&hellip;</div>}
          {scan.error && <Alert tone="bad">{(scan.error as Error).message}</Alert>}
          {scan.data && items.length === 0 && <Alert tone="ok">Очищать нечего</Alert>}
          {items.length > 0 && (
            <div className="flex flex-col gap-2.5">
              {items.map((i) => (
                <Checkbox
                  key={i.id}
                  checked={chosen?.has(i.id) ?? false}
                  onChange={() => toggle(i.id)}
                  label={
                    <span className="inline-flex flex-wrap items-center gap-2">
                      {i.title}
                      <span className="font-mono text-xs text-muted">{bytes(i.bytes)}</span>
                      {!i.safe && <span className="text-xs text-warn">с оговоркой</span>}
                    </span>
                  }
                  hint={i.detail}
                />
              ))}
            </div>
          )}
          {op.error && <Alert tone="bad">{op.error}</Alert>}
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-muted">
              {chosen && chosen.size > 0
                ? `освободится около ${bytes(total)}`
                : 'ничего не выбрано'}
            </span>
            <div className="grow" />
            <Button onClick={onClose}>Отмена</Button>
            <Button
              variant="primary"
              disabled={
                op.busy || scan.isFetching || !chosen || chosen.size === 0 || items.length === 0
              }
              onClick={run}
            >
              <Trash2 className="size-4" />
              Очистить
            </Button>
          </div>
        </>
      )}
    </Dialog>
  );
}
