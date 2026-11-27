/**
 * Приложения для подписки VLESS (/sub/<токен>): как каждое принимает подписку. id - как в
 * каталоге приложений панели (lib/apps.ts сервера), порядок - порядок выбора и рекомендаций: по
 * умолчанию первое из доступных на ОС посетителя. Подписка у всех одна (base64 ссылок VLESS),
 * различается только ссылка импорта. Нет link - приложение ссылки не открывает: копирование и QR.
 */
export interface SubApp {
  id: string;
  name: string;
  /** Ссылка импорта подписки url с подписью name. */
  link?: (url: string, name: string) => string;
  /** Где вставить скопированную ссылку, если ссылки импорта нет. */
  hint?: string;
}

const enc = encodeURIComponent;

export const SUB_APPS: readonly SubApp[] = [
  { id: 'happ', name: 'Happ', link: (url) => `happ://add/${url}` },
  {
    id: 'hiddify',
    name: 'Hiddify',
    link: (url, name) => `hiddify://install-config?url=${enc(url)}#${enc(name)}`,
  },
  { id: 'incy', name: 'INCY', link: (url) => `incy://import/${url}` },
  {
    id: 'v2rayng',
    name: 'v2rayNG',
    link: (url, name) => `v2rayng://install-sub?url=${enc(url)}#${enc(name)}`,
  },
  {
    id: 'v2rayn',
    name: 'v2rayN',
    hint: 'Скопируйте ссылку и добавьте её в настройках подписок v2rayN',
  },
];

/** Приложение по умолчанию, если у клиента не задано своё. */
export const DEFAULT_SUB_APP = 'happ';

/** Приложения клиента по сервисам: сейчас только подписка VLESS. */
export interface GClientApps {
  vless?: string;
}

export const subApp = (id: string | undefined): SubApp | undefined =>
  SUB_APPS.find((a) => a.id === id);

/** Ссылка импорта подписки для приложения; нет у приложения - сама подписка. */
export function subAppLink(id: string | undefined, url: string, name: string): string {
  return subApp(id)?.link?.(url, name) ?? url;
}
