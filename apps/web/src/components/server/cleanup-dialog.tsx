import { ActionOutput } from '@/components/action-output';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog } from '@/components/ui/dialog';
import { api } from '@/lib/api';
import { bytes } from '@/lib/format';
import { useQuery, useQueryClient } from '@tanstack/react-query';
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
  const qc = useQueryClient();
  const scan = useQuery({
    queryKey: ['cleanup', serverId],
    queryFn: () => api<{ items: CleanupItem[] }>(`/api/servers/${serverId}/cleanup`),
    enabled: open,
    staleTime: 0,
    retry: false,
  });
  const [chosen, setChosen] = useState<Set<string> | null>(null);
  const [actionId, setActionId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
  }, [open]);

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
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ actionId: string }>(`/api/servers/${serverId}/cleanup`, {
        method: 'POST',
        json: { ids: [...chosen] },
      });
      setActionId(r.actionId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Очистка диска" wide>
      {actionId ? (
        <>
          <ActionOutput
            actionId={actionId}
            onFinished={() => {
              void qc.invalidateQueries({ queryKey: ['servers'] });
              void qc.invalidateQueries({ queryKey: ['cleanup', serverId] });
            }}
          />
          <div className="flex justify-end">
            <Button onClick={onClose}>Закрыть</Button>
          </div>
        </>
      ) : (
        <>
          <div className="text-[13px] text-muted">
            Данные сервисов (тома docker, конфиги, базы) не трогаются. Безопасные категории отмечены
            сразу; остальные помечены и требуют понимания последствий.
          </div>
          {scan.isLoading && <div className="text-sm text-muted">Считаю, что можно удалить...</div>}
          {scan.error && <Alert tone="bad">{(scan.error as Error).message}</Alert>}
          {scan.data && items.length === 0 && (
            <Alert tone="ok">Мусора не найдено, чистить нечего.</Alert>
          )}
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
          {error && <Alert tone="bad">{error}</Alert>}
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-muted">
              {chosen && chosen.size > 0 ? `к удалению около ${bytes(total)}` : 'ничего не выбрано'}
            </span>
            <div className="grow" />
            <Button onClick={onClose}>Отмена</Button>
            <Button
              variant="primary"
              disabled={
                busy || scan.isFetching || !chosen || chosen.size === 0 || items.length === 0
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
