import { ServerOptions } from '@/components/server-options';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Field } from '@/components/ui/field';
import { Select } from '@/components/ui/select';
import { api } from '@/lib/api';
import { dateTime } from '@/lib/format';
import { useServers } from '@/lib/servers';
import { useAction } from '@/lib/use-action';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import type { BackupInfo } from '@vps/protocol';
import { Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

/** Источник настройки в адресе: копия, старый сервер при переносе, очистка ("1"/"0"). */
export interface SetupSearch {
  backup?: string | undefined;
  migrate?: string | undefined;
  wipe?: string | undefined;
}

/** Очистка по умолчанию: при переносе - да (сервер под старый), при восстановлении - нет. */
export const wipeOf = (q: SetupSearch) =>
  q.wipe === undefined ? Boolean(q.migrate) : q.wipe === '1';

type SourceMode = 'empty' | 'copy' | 'migrate';

/**
 * Откуда настройка: пустой сервер, резервная копия этого же сервера (из панели или скачанный
 * раньше файл - например, после переустановки) или перенос с другого сервера панели: его
 * копия (свежая, если он в сети) и его клиенты переходят сюда.
 */
export function SourceCard({
  serverId,
  q,
  installed,
  disabled,
}: {
  serverId: string;
  q: SetupSearch;
  installed: string[] | undefined;
  disabled: boolean;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [mode, setMode] = useState<SourceMode>(q.migrate ? 'migrate' : q.backup ? 'copy' : 'empty');
  const upload = useAction();
  const fileRef = useRef<HTMLInputElement>(null);
  const list = useQuery({
    queryKey: ['backups'],
    queryFn: () => api<BackupInfo[]>('/api/backups'),
    enabled: mode !== 'empty',
  });
  const servers = useServers();
  const others = (servers.data ?? []).filter((x) => x.id !== serverId);
  const old = others.find((x) => x.id === q.migrate);
  // копии с составом сервисов: свои - для восстановления, старого сервера - для переноса
  const owner = mode === 'migrate' ? q.migrate : serverId;
  const copies = (list.data ?? []).filter((b) => b.serverId === owner && b.manifest.setup);
  const go = (next: SetupSearch) =>
    void navigate({
      to: '/servers/$id/setup',
      params: { id: serverId },
      search: { backup: next.backup, migrate: next.migrate, wipe: next.wipe },
    });
  const off = disabled || upload.busy;
  const wipe = wipeOf(q);
  // старый сервер не в сети: свежую копию не снять - берётся последняя его копия в панели.
  // Адрес меняется от текущего, а не от снятого при рендере: выбор, сделанный за это время,
  // не затирается; для одного старого сервера - один раз
  const latest = copies[0]?.id;
  const needCopy = mode === 'migrate' && Boolean(old) && old?.status !== 'online' && !q.backup;
  const autoFor = useRef<string | null>(null);
  useEffect(() => {
    const from = q.migrate;
    if (!needCopy || !latest || !from || autoFor.current === from) return;
    autoFor.current = from;
    void navigate({
      to: '/servers/$id/setup',
      params: { id: serverId },
      search: (prev: SetupSearch) => ({
        backup: prev.migrate === from && !prev.backup ? latest : prev.backup,
        migrate: prev.migrate,
        wipe: prev.wipe,
      }),
      replace: true,
    });
  }, [needCopy, latest, navigate, serverId, q.migrate]);

  function send(file: File) {
    if (!owner) return;
    void upload.run(async () => {
      // файл становится копией того сервера, чья она: этого или старого при переносе
      const r = await api<{ id: string }>(`/api/servers/${owner}/backups/upload`, {
        method: 'POST',
        body: file,
        // скачанная копия зашифрована (.tar.gz.enc), старая - просто .tar.gz
        headers: { 'content-type': 'application/octet-stream' },
      });
      await qc.invalidateQueries({ queryKey: ['backups'] });
      go({ ...q, backup: r.id });
    });
  }

  const radio = (m: SourceMode, label: string) => (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="radio"
        name="setup-source"
        checked={mode === m}
        disabled={off}
        onChange={() => {
          setMode(m);
          go({});
        }}
      />
      {label}
    </label>
  );

  const fileButton = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept=".enc,.gz,.tgz,application/gzip,application/octet-stream"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) send(f);
        }}
      />
      <Button disabled={off || !owner} onClick={() => fileRef.current?.click()}>
        <Upload className={upload.busy ? 'size-4 animate-pulse' : 'size-4'} />
        {upload.busy ? 'Загрузка\u2026' : 'Загрузить файл'}
      </Button>
    </>
  );

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap gap-x-5 gap-y-2">
        {radio('empty', 'Пустой сервер')}
        {radio('copy', 'Резервная копия этого сервера')}
        {radio('migrate', 'Перенос с другого сервера')}
      </div>
      {mode === 'copy' && (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <Field label="Копия" htmlFor="setup-backup" className="grow">
            <Select
              id="setup-backup"
              value={q.backup ?? ''}
              disabled={off || list.isFetching}
              onChange={(e) => go({ ...q, backup: e.target.value || undefined })}
            >
              <option value="">{copies.length ? 'не выбрана' : 'копий этого сервера нет'}</option>
              {copies.map((b) => (
                <option key={b.id} value={b.id}>
                  {dateTime(b.createdAt)}
                </option>
              ))}
            </Select>
          </Field>
          {fileButton}
        </div>
      )}
      {mode === 'migrate' && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Старый сервер" htmlFor="setup-migrate" className="grow">
              <Select
                id="setup-migrate"
                value={q.migrate ?? ''}
                disabled={off}
                onChange={(e) => go({ migrate: e.target.value || undefined, wipe: q.wipe })}
              >
                <option value="">не выбран</option>
                <ServerOptions servers={others} />
              </Select>
            </Field>
            {q.migrate && (
              <Field label="Данные" htmlFor="setup-migrate-copy" className="grow">
                <Select
                  id="setup-migrate-copy"
                  value={q.backup ?? ''}
                  disabled={off || list.isFetching}
                  onChange={(e) => go({ ...q, backup: e.target.value || undefined })}
                >
                  <option value="">
                    {old?.status === 'online'
                      ? 'свежая копия при переносе'
                      : 'не в сети: выберите его копию'}
                  </option>
                  {copies.map((b) => (
                    <option key={b.id} value={b.id}>
                      копия от {dateTime(b.createdAt)}
                    </option>
                  ))}
                </Select>
              </Field>
            )}
            {q.migrate && fileButton}
          </div>
          <div className="text-xs text-muted">
            Сервисы ставятся как на старом сервере, данные&nbsp;&mdash; из копии, клиенты панели
            переходят сюда с теми же ключами. Если клиенты подключаются по имени (адрес для
            клиентов), его A-запись нужно перевести на IP этого сервера до запуска.
          </div>
        </div>
      )}
      {mode !== 'empty' && Boolean(installed?.length) && (
        <Checkbox
          label="Удалить то, что уже стоит на сервере"
          hint={`${installed?.join(', ')}: удаляются перед установкой, всё ставится заново`}
          checked={wipe}
          disabled={off}
          onChange={(e) => go({ ...q, wipe: e.target.checked ? '1' : '0' })}
        />
      )}
      {upload.error && <Alert tone="bad">{upload.error}</Alert>}
    </Card>
  );
}
