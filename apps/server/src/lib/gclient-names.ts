import { randomBytes } from 'node:crypto';
import { deviceOf } from '@vps/protocol';

/** Имена глобальных клиентов на серверах: латинская метка, токен, имя пира AWG. */

const TRANSLIT: Record<string, string> = {
  а: 'a',
  б: 'b',
  в: 'v',
  г: 'g',
  д: 'd',
  е: 'e',
  ё: 'e',
  ж: 'zh',
  з: 'z',
  и: 'i',
  й: 'y',
  к: 'k',
  л: 'l',
  м: 'm',
  н: 'n',
  о: 'o',
  п: 'p',
  р: 'r',
  с: 's',
  т: 't',
  у: 'u',
  ф: 'f',
  х: 'h',
  ц: 'c',
  ч: 'ch',
  ш: 'sh',
  щ: 'sch',
  ъ: '',
  ы: 'y',
  ь: '',
  э: 'e',
  ю: 'yu',
  я: 'ya',
};

/**
 * Латинское имя для 3X-UI (email) и MTProxyL (метка: [a-zA-Z0-9_-], до 32): транслит имени и
 * хвост из 4 hex, чтобы не совпасть с чужими клиентами ("ivan-a1b2").
 */
export function clientSlug(name: string): string {
  const base = [...name.toLowerCase()]
    .map((ch) => TRANSLIT[ch] ?? ch)
    .join('')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${base || 'client'}-${randomBytes(2).toString('hex')}`;
}

/** Токен подписки и личной страницы: 32 hex, 128 бит; живёт только в панели. */
export const newClientToken = () => randomBytes(16).toString('hex');

/**
 * subId клиента в 3X-UI: случайный и с токеном не связан - root на одном сервере
 * читает x-ui.db, но токены личных страниц оттуда не узнать. Панели subId нужен только, чтобы
 * взять у 3X-UI ссылки клиента (clients/subLinks); подписку отдаёт сама панель.
 */
export const newXuiSubId = () => randomBytes(8).toString('hex');

/** Имя пира на сервере (видно в панели и приложении Amnezia): "Иван (iPhone/iPad: телефон)". */
export function peerName(c: { name: string }, d: { name: string; type: string }) {
  const dev = [deviceOf(d.type)?.title, d.name].filter(Boolean).join(': ');
  return (dev ? `${c.name} (${dev})` : c.name).slice(0, 64);
}
