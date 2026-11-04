import { ActionOutput } from '@/components/action-output';
import { SshPortFields, validSshPort } from '@/components/server/ssh-port-fields';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';
import { serverLock } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ServerDetail } from '@vps/protocol';
import { useState } from 'react';

/** Настройка действующего SSH-порта, отдельно от сохранения имени и тегов. */
export function SshPortSettings({
  serverId,
  blocked,
  onBusy,
}: {
  serverId: string;
  blocked: boolean;
  onBusy: (value: boolean) => void;
}) {
  const qc = useQueryClient();
  const server = useQuery({
    queryKey: ['servers', serverId],
    queryFn: () => api<ServerDetail>(`/api/servers/${serverId}`),
  });
  const [picking, setPicking] = useState(false);
  const [port, setPort] = useState('');
  const [ready, setReady] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const op = useAction();
  const disabled =
    blocked ||
    picking ||
    op.busy ||
    running ||
    server.isFetching ||
    !server.data ||
    server.data.status !== 'online' ||
    serverLock(server.data).busy;
  return (
    <div className="flex flex-col gap-3 border-t border-border pt-4">
      <p className="font-medium">SSH: порт {server.data?.sshPort ?? '...'}</p>
      <SshPortFields
        serverId={serverId}
        port={port}
        ready={ready}
        disabled={disabled}
        onPort={setPort}
        onReady={setReady}
        onBusy={(value) => {
          setPicking(value);
          onBusy(value);
        }}
      />
      <Button
        disabled={disabled || !ready || !validSshPort(port)}
        onClick={() =>
          void op.run(async () => {
            onBusy(true);
            try {
              const result = await api<{ actionId: string }>(`/api/servers/${serverId}/ssh-port`, {
                method: 'POST',
                json: { port: Number(port), externalFirewallReady: ready },
              });
              setActionId(result.actionId);
              setRunning(true);
            } catch (error) {
              onBusy(false);
              throw error;
            }
          })
        }
      >
        Изменить порт SSH
      </Button>
      {(op.error || server.error) && <Alert tone="bad">{op.error || server.error?.message}</Alert>}
      {actionId && (
        <ActionOutput
          actionId={actionId}
          onFinished={() => {
            void qc.invalidateQueries({ queryKey: ['servers'] }).finally(() => {
              setRunning(false);
              onBusy(false);
            });
          }}
        />
      )}
    </div>
  );
}
