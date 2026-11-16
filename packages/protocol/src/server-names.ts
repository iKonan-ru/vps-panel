/**
 * Случайные имена серверов "Прилагательное Животное" (Kind Badger, Speedy Eagle): латиница -
 * из имени составляются поддомены панели и адрес для клиентов (kind-badger). Слова короткие,
 * дружелюбные и однозначные.
 */
export const NAME_ADJECTIVES = [
  'agile',
  'amber',
  'ancient',
  'bold',
  'brave',
  'breezy',
  'bright',
  'brisk',
  'calm',
  'clever',
  'cosmic',
  'crisp',
  'curious',
  'daring',
  'dashing',
  'eager',
  'fancy',
  'fearless',
  'fluffy',
  'frosty',
  'gentle',
  'giant',
  'glad',
  'golden',
  'graceful',
  'happy',
  'hardy',
  'humble',
  'jolly',
  'keen',
  'kind',
  'lively',
  'lucky',
  'mellow',
  'merry',
  'mighty',
  'misty',
  'modest',
  'nimble',
  'noble',
  'polar',
  'proud',
  'quick',
  'quiet',
  'rapid',
  'rusty',
  'shiny',
  'silent',
  'silver',
  'smart',
  'snowy',
  'sonic',
  'speedy',
  'spry',
  'steady',
  'stellar',
  'sturdy',
  'sunny',
  'swift',
  'tidy',
  'tiny',
  'vivid',
  'wild',
  'wise',
  'witty',
  'zesty',
] as const;

export const NAME_ANIMALS = [
  'alpaca',
  'axolotl',
  'badger',
  'beaver',
  'bison',
  'bobcat',
  'capybara',
  'caracal',
  'cheetah',
  'chinchilla',
  'condor',
  'cougar',
  'coyote',
  'dingo',
  'dolphin',
  'eagle',
  'falcon',
  'ferret',
  'gecko',
  'gazelle',
  'gopher',
  'hedgehog',
  'heron',
  'ibex',
  'iguana',
  'jackal',
  'jaguar',
  'koala',
  'lemur',
  'leopard',
  'llama',
  'lynx',
  'manatee',
  'marmot',
  'meerkat',
  'mongoose',
  'moose',
  'narwhal',
  'ocelot',
  'orca',
  'osprey',
  'otter',
  'owl',
  'panda',
  'panther',
  'pelican',
  'penguin',
  'platypus',
  'puffin',
  'quokka',
  'raccoon',
  'raven',
  'reindeer',
  'salamander',
  'seal',
  'sparrow',
  'squirrel',
  'tapir',
  'tiger',
  'toucan',
  'walrus',
  'wolf',
  'wombat',
  'yak',
  'zebra',
] as const;

/** Вид имени в поддомене: занятым считается и "kind-badger" для "Kind Badger". */
const slugOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Случайное имя, которого нет среди taken (сравнение по виду в поддомене). Все сочетания заняты
 * (несколько тысяч серверов) - к имени добавляется номер.
 */
export function randomServerName(
  taken: Iterable<string> = [],
  rnd: () => number = Math.random,
): string {
  const used = new Set([...taken].map(slugOf));
  const pick = <T>(list: readonly T[]) => list[Math.floor(rnd() * list.length)] as T;
  let name = '';
  for (let i = 0; i < 100; i++) {
    name = `${title(pick(NAME_ADJECTIVES))} ${title(pick(NAME_ANIMALS))}`;
    if (!used.has(slugOf(name))) return name;
  }
  let n = 2;
  while (used.has(slugOf(`${name} ${n}`))) n++;
  return `${name} ${n}`;
}
