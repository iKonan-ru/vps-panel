import { LinkButton } from '@/components/ui/link-button';
import { QrCode } from '@/components/ui/qr-code';
import { Tabs } from '@/components/ui/tabs';
import { useState } from 'react';

/** Ссылки MTProxy (TLS и t.me) с QR - для вкладки MTProxyL и карточки клиента. */
export function MtLinksView({
  links,
  label,
  raw,
}: { links: string[]; label: string; raw?: string }) {
  const [kind, setKind] = useState<'tls' | 'web'>('tls');
  const web = links.find((l) => l.startsWith('https://t.me/'));
  const tls = links.find((l) => l.startsWith('tg://'));
  const link = (kind === 'tls' ? tls : web) ?? tls ?? web;
  if (!link)
    return (
      <pre className="whitespace-pre-wrap font-mono text-xs [overflow-wrap:anywhere]">
        {raw || 'ссылок нет'}
      </pre>
    );
  const isTls = link === tls;
  return (
    <div className="flex flex-col items-center gap-4">
      {tls && web && (
        <Tabs
          className="w-full"
          items={[
            { id: 'tls', title: 'TLS' },
            { id: 'web', title: 't.me' },
          ]}
          value={kind}
          onChange={setKind}
        />
      )}
      <QrCode text={link} alt={`QR-код ссылки ${label}`} />
      {/* слева ссылка (Telegram предлагает добавить прокси), справа копирование */}
      <LinkButton
        href={link}
        variant="primary"
        size="md"
        wide
        copyTitle={isTls ? 'Скопировать TLS-ссылку' : 'Скопировать ссылку t.me'}
      >
        Подключить прокси
      </LinkButton>
    </div>
  );
}
