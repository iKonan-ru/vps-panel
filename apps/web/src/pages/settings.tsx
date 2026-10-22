import { FirefoxSettings } from '@/components/firefox-settings';
import { OpenfluxDocsSettings } from '@/components/openflux-docs-settings';
import { PanelBackupSettings } from '@/components/panel-backup-settings';
import { PANEL_VERSION_ANCHOR } from '@/components/panel-version-badge';
import { PanelVersionSettings } from '@/components/panel-version-settings';
import { ReachSettings } from '@/components/reach-settings';
import { TagsSettings } from '@/components/tags-settings';
import { TelegramSettings } from '@/components/telegram-settings';
import { PageTitle } from '@/components/ui/page-title';
import { WdttSettings } from '@/components/wdtt-settings';

/** Настройки панели; аккаунт - отдельная страница (меню пользователя). */
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

      <TagsSettings />

      <WdttSettings />
      <OpenfluxDocsSettings />
      <FirefoxSettings />
    </>
  );
}
