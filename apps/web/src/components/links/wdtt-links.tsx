import { InfoTip } from '@/components/ui/info-tip';
import { LinkButton } from '@/components/ui/link-button';
import { QrCode } from '@/components/ui/qr-code';

export interface WdttLinks {
  qwdtt: string;
  wdtt: string;
}

/** Ссылки пароля WDTT с QR: вкладка WDTT и карточка глобального клиента. */
export function WdttLinksView({ links }: { links: WdttLinks }) {
  return (
    <div className="flex flex-col items-center gap-3">
      <div className="flex items-center gap-1 self-stretch text-[13px] text-muted">
        Для приложений qWDTT и PWDTT
        <InfoTip>
          Старая ссылка wdtt:// нужна на случай несовместимости. QR содержит ссылку qwdtt://.
        </InfoTip>
      </div>
      <QrCode text={links.qwdtt} alt="QR-код qwdtt" />
      <LinkButton
        href={links.qwdtt}
        variant="primary"
        size="md"
        wide
        title="Добавить в приложение qWDTT"
        copyTitle="Скопировать ссылку qwdtt://"
      >
        Подключить (qwdtt://)
      </LinkButton>
      <LinkButton
        href={links.wdtt}
        size="md"
        wide
        title="Старый формат wdtt://"
        copyTitle="Скопировать ссылку wdtt://"
      >
        Старая ссылка (wdtt://)
      </LinkButton>
    </div>
  );
}
