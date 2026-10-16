import { FirefoxSettings } from '@/components/firefox-settings';
import { OpenfluxDocsSettings } from '@/components/openflux-docs-settings';
import { PanelBackupSettings } from '@/components/panel-backup-settings';
import { PANEL_VERSION_ANCHOR } from '@/components/panel-version-badge';
import { PanelVersionSettings } from '@/components/panel-version-settings';
import { ReachSettings } from '@/components/reach-settings';
import { TelegramSettings } from '@/components/telegram-settings';
import { ButtonLink } from '@/components/ui/button';
import { PageTitle } from '@/components/ui/page-title';
import { Section } from '@/components/ui/section';
import { WdttSettings } from '@/components/wdtt-settings';
import { UserCog } from 'lucide-react';

/** Настройки панели; аккаунт - отдельная страница. */
export function SettingsPage() {
  return (
    <>
      <PageTitle>Настройки</PageTitle>

      {/* якорь: сюда ведёт плашка версии у логотипа */}
      <div id={PANEL_VERSION_ANCHOR} className="scroll-mt-4">
        <PanelVersionSettings />
      </div>

      <PanelBackupSettings />

      <TelegramSettings />

      <ReachSettings />

      <WdttSettings />
      <OpenfluxDocsSettings />
      <FirefoxSettings />

      <Section
        title="Аккаунт"
        actions={
          <ButtonLink size="sm" to="/account" label="Открыть">
            <UserCog className="size-3.5" />
          </ButtonLink>
        }
      >
        <div className="px-4 py-3 text-[13px] text-muted">
          Логин, пароль, двухфакторная аутентификация, сессии
        </div>
      </Section>
    </>
  );
}
