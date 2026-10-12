import { useNavigate } from '@tanstack/react-router';

/** Команда каталога, которая удаляет сервис этого вида (вид - как в инвентаре агента). */
export const uninstallCommand: Record<string, string> = {
  xui: 'xui-uninstall',
  mtproxyl: 'mtproxyl-uninstall',
  wdtt: 'wdtt-uninstall',
  amnezia: 'awg-uninstall',
  openflux: 'openflux-uninstall',
  naive: 'naive-uninstall',
};

/**
 * Переход к удалению сервиса: форма команды каталога с этим сервером (там план, проверки и
 * подтверждение "да, удалить"); preset - поля формы (контейнер AWG).
 */
export function useUninstall() {
  const navigate = useNavigate();
  return (serverId: string, kind: string, preset?: Record<string, string>) => {
    const id = uninstallCommand[kind];
    if (!id) return;
    void navigate({
      to: '/commands/$id',
      params: { id },
      search: {
        server: serverId,
        run: undefined,
        tab: undefined,
        ...(preset ? { preset } : {}),
      },
    });
  };
}
