/**
 * Схемы ссылок, которые панель открывает: веб, Telegram, приложения подписки (Happ, Hiddify, INCY,
 * v2rayNG), WDTT, Amnezia, OpenFlux и свои адреса. Ссылки приходят и от агентов, с недоверенных серверов: javascript:, data: и прочие схемы
 * не открываются - не полагаясь на то, что javascript: гасит react-dom.
 */
const SAFE =
  /^(https?:\/\/|tg:\/\/|happ:\/\/|hiddify:\/\/|incy:\/\/|v2rayng:\/\/|wdtt:\/\/|qwdtt:\/\/|vpn:\/\/|openflux:\/\/|\/(?!\/))/i;

export const isSafeHref = (href: string | null | undefined): href is string =>
  !!href && SAFE.test(href.trim());
