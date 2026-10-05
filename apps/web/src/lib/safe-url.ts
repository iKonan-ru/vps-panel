/**
 * Схемы ссылок, которые панель открывает: веб, Telegram, Happ, WDTT, Amnezia, OpenFlux и
 * свои адреса (/api/...). Ссылки приходят и от агентов, то есть с недоверенных серверов:
 * javascript:, data: и прочие схемы ОС кнопкой не открываются. Сейчас javascript: гасит и сам
 * react-dom, но защита не должна держаться на его внутренней детали.
 */
const SAFE =
  /^(https?:\/\/|tg:\/\/|happ:\/\/|wdtt:\/\/|qwdtt:\/\/|vpn:\/\/|openflux:\/\/|\/(?!\/))/i;

export const isSafeHref = (href: string | null | undefined): href is string =>
  !!href && SAFE.test(href.trim());
