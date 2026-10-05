/**
 * Ссылки прокси из вывода `mtproxyl secret link`. Команда печатает только tg://proxy?...;
 * ссылка https://t.me/proxy?... - та же с теми же параметрами, её собираем сами. Цветовые
 * коды терминала убираются, иначе прилипают к концу ссылки. Нужна и окну пользователя
 * MTProxyL, и панели (глобальный клиент, личная страница).
 */
export function parseMtLinks(text: string): string[] {
  const plain = text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
  const links = [
    ...new Set(plain.match(/(?:tg:\/\/proxy|https:\/\/t\.me\/proxy)\?[^\s'"<>]+/g) ?? []),
  ];
  const tg = links.find((l) => l.startsWith('tg://'));
  if (tg && !links.some((l) => l.startsWith('https://t.me/')))
    links.unshift(tg.replace('tg://proxy?', 'https://t.me/proxy?'));
  return links;
}
