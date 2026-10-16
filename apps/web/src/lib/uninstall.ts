import { useNavigate } from '@tanstack/react-router';
import { serviceByKind } from '@vps/protocol';

/** Переход к удалению сервиса - в форму команды каталога; preset - поля формы (контейнер AWG). */
export function useUninstall() {
  const navigate = useNavigate();
  return (serverId: string, kind: string, preset?: Record<string, string>) => {
    const id = serviceByKind(kind)?.uninstall;
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
