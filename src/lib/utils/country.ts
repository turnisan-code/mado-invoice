import type { CountryOption, Language, TaxTreatment } from '@/types'

// ISO 3166-1 alpha-2, plus XK (Kosovo), which banks and tax offices use as well.
const COUNTRY_CODES = [
  'AD', 'AE', 'AF', 'AG', 'AI', 'AL', 'AM', 'AO', 'AQ', 'AR', 'AS', 'AT', 'AU', 'AW', 'AX', 'AZ',
  'BA', 'BB', 'BD', 'BE', 'BF', 'BG', 'BH', 'BI', 'BJ', 'BL', 'BM', 'BN', 'BO', 'BQ', 'BR', 'BS',
  'BT', 'BV', 'BW', 'BY', 'BZ', 'CA', 'CC', 'CD', 'CF', 'CG', 'CH', 'CI', 'CK', 'CL', 'CM', 'CN',
  'CO', 'CR', 'CU', 'CV', 'CW', 'CX', 'CY', 'CZ', 'DE', 'DJ', 'DK', 'DM', 'DO', 'DZ', 'EC', 'EE',
  'EG', 'EH', 'ER', 'ES', 'ET', 'FI', 'FJ', 'FK', 'FM', 'FO', 'FR', 'GA', 'GB', 'GD', 'GE', 'GF',
  'GG', 'GH', 'GI', 'GL', 'GM', 'GN', 'GP', 'GQ', 'GR', 'GS', 'GT', 'GU', 'GW', 'GY', 'HK', 'HM',
  'HN', 'HR', 'HT', 'HU', 'ID', 'IE', 'IL', 'IM', 'IN', 'IO', 'IQ', 'IR', 'IS', 'IT', 'JE', 'JM',
  'JO', 'JP', 'KE', 'KG', 'KH', 'KI', 'KM', 'KN', 'KP', 'KR', 'KW', 'KY', 'KZ', 'LA', 'LB', 'LC',
  'LI', 'LK', 'LR', 'LS', 'LT', 'LU', 'LV', 'LY', 'MA', 'MC', 'MD', 'ME', 'MF', 'MG', 'MH', 'MK',
  'ML', 'MM', 'MN', 'MO', 'MP', 'MQ', 'MR', 'MS', 'MT', 'MU', 'MV', 'MW', 'MX', 'MY', 'MZ', 'NA',
  'NC', 'NE', 'NF', 'NG', 'NI', 'NL', 'NO', 'NP', 'NR', 'NU', 'NZ', 'OM', 'PA', 'PE', 'PF', 'PG',
  'PH', 'PK', 'PL', 'PM', 'PN', 'PR', 'PS', 'PT', 'PW', 'PY', 'QA', 'RE', 'RO', 'RS', 'RU', 'RW',
  'SA', 'SB', 'SC', 'SD', 'SE', 'SG', 'SH', 'SI', 'SJ', 'SK', 'SL', 'SM', 'SN', 'SO', 'SR', 'SS',
  'ST', 'SV', 'SX', 'SY', 'SZ', 'TC', 'TD', 'TF', 'TG', 'TH', 'TJ', 'TK', 'TL', 'TM', 'TN', 'TO',
  'TR', 'TT', 'TV', 'TW', 'TZ', 'UA', 'UG', 'UM', 'US', 'UY', 'UZ', 'VA', 'VC', 'VE', 'VG', 'VI',
  'VN', 'VU', 'WF', 'WS', 'XK', 'YE', 'YT', 'ZA', 'ZM', 'ZW',
]
const CODES = new Set(COUNTRY_CODES)

export const EU_COUNTRIES = new Set([
  'AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU',
  'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK',
])

// Free-text values found in old client rows; mirrors the mapping in 20261029_clients_numbering.sql.
const NAME_TO_CODE: Record<string, string> = {
  a: 'AT', austria: 'AT', österreich: 'AT', oesterreich: 'AT',
  belgium: 'BE', belgien: 'BE',
  bulgaria: 'BG', bulgarien: 'BG',
  croatia: 'HR', kroatien: 'HR',
  cyprus: 'CY', zypern: 'CY',
  czechia: 'CZ', 'czech republic': 'CZ', tschechien: 'CZ', 'tschechische republik': 'CZ',
  denmark: 'DK', dänemark: 'DK', daenemark: 'DK',
  estonia: 'EE', estland: 'EE',
  finland: 'FI', finnland: 'FI',
  france: 'FR', frankreich: 'FR',
  d: 'DE', germany: 'DE', deutschland: 'DE',
  el: 'GR', greece: 'GR', griechenland: 'GR',
  hungary: 'HU', ungarn: 'HU',
  ireland: 'IE', irland: 'IE',
  italy: 'IT', italien: 'IT',
  latvia: 'LV', lettland: 'LV',
  lithuania: 'LT', litauen: 'LT',
  luxembourg: 'LU', luxemburg: 'LU',
  malta: 'MT',
  netherlands: 'NL', 'the netherlands': 'NL', niederlande: 'NL', holland: 'NL',
  poland: 'PL', polen: 'PL',
  portugal: 'PT',
  romania: 'RO', rumänien: 'RO', rumaenien: 'RO',
  slovakia: 'SK', slowakei: 'SK',
  slovenia: 'SI', slowenien: 'SI',
  spain: 'ES', spanien: 'ES',
  sweden: 'SE', schweden: 'SE',
  switzerland: 'CH', schweiz: 'CH',
  liechtenstein: 'LI',
  norway: 'NO', norwegen: 'NO',
  uk: 'GB', 'united kingdom': 'GB', 'great britain': 'GB', großbritannien: 'GB', grossbritannien: 'GB', 'vereinigtes königreich': 'GB',
  usa: 'US', 'united states': 'US', 'vereinigte staaten': 'US',
}

export function isCountryCode(value: string | null | undefined): value is string {
  return !!value && CODES.has(value)
}

// The code for a stored value: a code as it is, a known German/English name mapped, otherwise null.
export function toCountryCode(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  if (CODES.has(v.toUpperCase())) return v.toUpperCase()
  return NAME_TO_CODE[v.toLowerCase()] ?? null
}

const displayNames = new Map<Language, Intl.DisplayNames>()

function regionNames(lang: Language): Intl.DisplayNames {
  let names = displayNames.get(lang)
  if (!names) {
    names = new Intl.DisplayNames([lang], { type: 'region' })
    displayNames.set(lang, names)
  }
  return names
}

// Localised name for a stored country; a value that is not a code (an unmapped old row) is printed as is.
export function countryName(value: string | null | undefined, lang: Language): string {
  if (!value) return ''
  if (!isCountryCode(value)) return value
  return regionNames(lang).of(value) ?? value
}

// Austria first, then the rest of the EU, then everything else, each by localised name.
export function countryOptions(lang: Language): CountryOption[] {
  const collator = new Intl.Collator(lang)
  const rank = (o: CountryOption) => (o.code === 'AT' ? 0 : o.eu ? 1 : 2)
  return COUNTRY_CODES
    .map(code => ({ code, name: countryName(code, lang), eu: EU_COUNTRIES.has(code) }))
    .sort((a, b) => rank(a) - rank(b) || collator.compare(a.name, b.name))
}

// Austria → Austrian VAT; EU business with a valid UID → reverse charge; EU without UID →
// Austrian VAT (B2C); outside the EU → non-EU. null when no country is chosen.
export function suggestTaxTreatment(country: string | null | undefined, hasValidUid: boolean): TaxTreatment | null {
  if (!isCountryCode(country)) return null
  if (country === 'AT') return 'at_vat'
  if (EU_COUNTRIES.has(country)) return hasValidUid ? 'eu_reverse_charge' : 'at_vat'
  return 'non_eu'
}
