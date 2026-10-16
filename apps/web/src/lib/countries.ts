/**
 * Страны для формы хостинга. В базе хранится код ISO 3166-1 alpha-2 ("FI"),
 * название по-русски даёт Intl.DisplayNames, флаг - два символа-индикатора
 * региона (emoji). Старые записи со свободным текстом показываются как есть.
 */
const CODES =
  'AD AE AF AG AL AM AO AR AT AU AZ BA BB BD BE BF BG BH BI BJ BN BO BR BS BT BW BY BZ CA CD CF CG CH CI CL CM CN CO CR CU CV CY CZ DE DJ DK DM DO DZ EC EE EG ER ES ET FI FJ FM FR GA GB GD GE GH GM GN GQ GR GT GW GY HN HR HT HU ID IE IL IN IQ IR IS IT JM JO JP KE KG KH KI KM KN KP KR KW KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MG MH MK ML MM MN MR MT MU MV MW MX MY MZ NA NE NG NI NL NO NP NR NZ OM PA PE PG PH PK PL PT PW PY QA RO RS RU RW SA SB SC SD SE SG SI SK SL SM SN SO SR SS ST SV SY SZ TD TG TH TJ TL TM TN TO TR TT TV TW TZ UA UG US UY UZ VA VC VE VN VU WS YE ZA ZM ZW HK MO PR GI IM JE GG'.split(
    ' ',
  );

const names = (() => {
  try {
    return new Intl.DisplayNames(['ru'], { type: 'region' });
  } catch {
    return null;
  }
})();

export function isCountryCode(v: string): boolean {
  return /^[A-Z]{2}$/.test(v);
}

function flagOf(code: string): string {
  if (!isCountryCode(code)) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

export function countryName(v: string): string {
  if (!v) return '';
  if (!isCountryCode(v)) return v;
  return names?.of(v) ?? v;
}

/** Флаг и название для показа в таблицах и карточке. */
export function countryLabel(v: string): string {
  if (!v) return '';
  const flag = flagOf(v);
  return flag ? `${flag} ${countryName(v)}` : v;
}

export const COUNTRIES: { code: string; name: string; flag: string }[] = CODES.map((code) => ({
  code,
  name: countryName(code),
  flag: flagOf(code),
})).sort((a, b) => a.name.localeCompare(b.name, 'ru'));
