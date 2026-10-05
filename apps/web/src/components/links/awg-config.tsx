import { AppLinks } from '@/components/app-links';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { QrCode } from '@/components/ui/qr-code';
import { Select } from '@/components/ui/select';
import { Tabs } from '@/components/ui/tabs';
import { api } from '@/lib/api';
import { useCopy } from '@/lib/use-copy';
import { useQuery } from '@tanstack/react-query';
import { deviceOf } from '@vps/protocol';
import { Check, Copy, Download } from 'lucide-react';
import { useEffect, useState } from 'react';

interface AwgConfigs {
  version: string;
  conf: string;
  wg: string | null;
  vpn: string;
  frames: string[];
  /** Как подключение называется у клиента ("(флаг) Страна :: Хостинг"). */
  title: string;
  /** Имя .conf без расширения = имя туннеля в AmneziaWG ("FI-Hoster"). */
  fileName: string;
}

type Format = 'awg' | 'amnezia' | 'wg';

function download(text: string, file: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = file;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Конфиг клиента в трёх форматах: .conf для приложений AmneziaWG, ключ vpn:// для Amnezia VPN
 * (QR - серия кадров, листается сама), обычный WireGuard - только для серверов без обфускации.
 * Конфиги не кэшируются: в них приватный ключ.
 */
export function ClientConfig({
  serverId,
  container,
  publicKey,
  name,
  device,
}: {
  serverId: string;
  container: string;
  publicKey: string;
  name: string;
  device: string | undefined;
}) {
  const [mtu, setMtu] = useState<number>(deviceOf(device)?.mtu ?? 1280);
  const [format, setFormat] = useState<Format>('awg');
  const [frame, setFrame] = useState(0);
  const { copied, copy, reset: resetCopied } = useCopy();
  const { data, error, isLoading } = useQuery({
    queryKey: ['awg-config', serverId, container, publicKey, mtu],
    queryFn: () =>
      api<AwgConfigs>(`/api/servers/${serverId}/awg/config`, {
        method: 'POST',
        json: { container, publicKey, mtu },
      }),
    gcTime: 0,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const frames = data?.frames ?? [];
  const text =
    format === 'awg' ? data?.conf : format === 'wg' ? (data?.wg ?? undefined) : data?.vpn;
  const qrText = format === 'amnezia' ? frames[frame % Math.max(1, frames.length)] : text;

  // кадры QR Amnezia листаются, как в приложении
  useEffect(() => {
    if (format !== 'amnezia' || frames.length < 2) return;
    const t = setInterval(() => setFrame((f) => f + 1), 1200);
    return () => clearInterval(t);
  }, [format, frames.length]);

  if (isLoading) return <div className="text-sm text-muted">Собираю конфиг...</div>;
  if (error) return <Alert tone="bad">{error.message}</Alert>;
  if (!data || !text) return null;
  const tabs: { id: Format; title: string }[] = [
    { id: 'awg', title: 'AmneziaWG' },
    { id: 'amnezia', title: 'Amnezia VPN' },
    ...(data.wg ? [{ id: 'wg' as const, title: 'WireGuard' }] : []),
  ];
  const hint =
    format === 'awg'
      ? `Приложение AmneziaWG: импорт из файла (туннель будет называться ${data.fileName}) или QR - тогда приложение спросит имя, введи ${data.fileName}.`
      : format === 'amnezia'
        ? `Приложение Amnezia VPN: "Добавить" - вставить ключ или сканировать QR. Подключение будет называться "${data.title}".`
        : `Обычный WireGuard: сервер без обфускации. Имя туннеля - ${data.fileName}.`;
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex w-full flex-wrap items-center gap-3">
        <Tabs
          className="min-w-0 grow"
          items={tabs}
          value={format}
          onChange={(f) => {
            setFormat(f);
            setFrame(0);
            resetCopied();
          }}
        />
        <Select
          size="sm"
          aria-label="MTU"
          value={String(mtu)}
          onChange={(e) => setMtu(Number(e.target.value))}
        >
          <option value="1280">MTU 1280: телефон, роутер</option>
          <option value="1376">MTU 1376: компьютер</option>
        </Select>
      </div>
      {qrText && (
        <QrCode
          text={qrText}
          alt={`QR-код: ${name}`}
          level="L"
          note={
            format === 'amnezia' &&
            frames.length > 1 && (
              <div className="text-xs text-muted">
                кадр {(frame % frames.length) + 1} из {frames.length}: держи камеру, пока приложение
                не соберёт все
              </div>
            )
          }
        />
      )}
      <div className="text-center text-xs text-muted">{hint}</div>
      {format !== 'wg' && (
        <AppLinks
          appId={format === 'amnezia' ? 'amnezia-vpn' : 'amneziawg'}
          os={deviceOf(device)?.os}
        />
      )}
      <div className="flex w-full flex-wrap gap-2">
        <Button className="grow justify-center" onClick={() => copy(text)}>
          {copied ? <Check className="size-4 text-ok" /> : <Copy className="size-4" />}
          {copied
            ? 'Скопировано'
            : format === 'amnezia'
              ? 'Скопировать ключ'
              : 'Скопировать конфиг'}
        </Button>
        {format !== 'amnezia' && (
          <Button
            className="grow justify-center"
            onClick={() => download(text, `${data.fileName}.conf`)}
          >
            <Download className="size-4" />
            Скачать .conf
          </Button>
        )}
      </div>
    </div>
  );
}
