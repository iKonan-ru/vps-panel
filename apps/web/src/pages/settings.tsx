import { FirefoxSettings } from '@/components/firefox-settings';
import { OpenfluxDocsSettings } from '@/components/openflux-docs-settings';
import { PanelBackupSettings } from '@/components/panel-backup-settings';
import { PanelVersionSettings } from '@/components/panel-version-settings';
import { ReachSettings } from '@/components/reach-settings';
import { TelegramSettings } from '@/components/telegram-settings';
import { ButtonLink } from '@/components/ui/button';
import { PageTitle } from '@/components/ui/page-title';
import { Section } from '@/components/ui/section';
import { WdttSettings } from '@/components/wdtt-settings';
import { UserCog } from 'lucide-react';

/** Настройки: версия панели, бэкап, уведомления (с маршрутом до Telegram), WDTT, Firefox; аккаунт - своя страница. */
export function SettingsPage() {
  return (
    <>
      <PageTitle>Настройки</PageTitle>

      <PanelVersionSettings />

      <PanelBackupSettings />

      <TelegramSettings />

      <ReachSettings />

      <WdttSettings />
      <OpenfluxDocsSettings />
      <FirefoxSettings />

      <Section
        title="Аккаунт и безопасность входа"
        info="Логин, пароль, 2FA и резервные коды администратора, попытки входа и активные сессии - в разделе Аккаунт (он же открывается по нажатию на своё имя в меню)."
        actions={
          <ButtonLink size="sm" to="/account" label="Аккаунт">
            <UserCog className="size-3.5" />
          </ButtonLink>
        }
      >
        <div className="px-4 py-3 text-[13px] text-muted">
          Смена логина и пароля, перенастройка 2FA, новые резервные коды, сессии и попытки входа.
        </div>
      </Section>
    </>
  );
}
