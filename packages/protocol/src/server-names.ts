/**
 * Случайные имена серверов "Прилагательное Животное" или "Прилагательное Растение" (Kind Badger,
 * Misty Willow): латиница - из имени составляются поддомены панели и адрес для клиентов
 * (kind-badger). Слова короткие, дружелюбные и однозначные; имён людей нет - их легко спутать с
 * клиентами.
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

export const NAME_PLANTS = [
  'acacia',
  'aloe',
  'aspen',
  'bamboo',
  'basil',
  'birch',
  'cactus',
  'cedar',
  'clover',
  'cypress',
  'dahlia',
  'fern',
  'fig',
  'hazel',
  'heather',
  'iris',
  'ivy',
  'jasmine',
  'juniper',
  'larch',
  'laurel',
  'lavender',
  'lilac',
  'lily',
  'linden',
  'lotus',
  'magnolia',
  'maple',
  'mimosa',
  'mint',
  'myrtle',
  'oak',
  'olive',
  'orchid',
  'palm',
  'peony',
  'pine',
  'poppy',
  'rowan',
  'saffron',
  'sage',
  'sequoia',
  'spruce',
  'thistle',
  'thyme',
  'tulip',
  'violet',
  'willow',
  'yucca',
] as const;

const NAME_NOUNS: readonly string[] = [...NAME_ANIMALS, ...NAME_PLANTS];

/** Вид имени в поддомене: занятым считается и "kind-badger" для "Kind Badger". */
const slugOf = (name: string) =>
  name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const title = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Случайное имя, которого нет среди taken (сравнение по виду в поддомене), из слов, которых ещё нет
 * в именах taken: ни прилагательное, ни существительное не повторяются - серверы различаются с
 * первого взгляда. Свободные слова кончились - повторяются, но не имя целиком; все сочетания
 * заняты - к имени добавляется номер.
 */
export function randomServerName(
  taken: Iterable<string> = [],
  rnd: () => number = Math.random,
): string {
  const slugs = [...taken].map(slugOf);
  const used = new Set(slugs);
  const words = new Set(slugs.flatMap((s) => s.split('-')));
  const fresh = (list: readonly string[]) => {
    const left = list.filter((w) => !words.has(w));
    return left.length ? left : list;
  };
  const adjectives = fresh(NAME_ADJECTIVES);
  const nouns = fresh(NAME_NOUNS);
  const pick = (list: readonly string[]) => list[Math.floor(rnd() * list.length)] as string;
  let name = '';
  for (let i = 0; i < 100; i++) {
    name = `${title(pick(adjectives))} ${title(pick(nouns))}`;
    if (!used.has(slugOf(name))) return name;
  }
  let n = 2;
  while (used.has(slugOf(`${name} ${n}`))) n++;
  return `${name} ${n}`;
}
