// Where a supplier's VAT comes from, read from its country and its VAT ID (UID), and the
// country, currency and rate helpers both jobs share (PR „Vorsteuer“). Job 1 (the
// classifier's guards) and Job 2 (the Belege form) decide with the same rules.
//
// Pure and client-safe: no server module and no env variable of its own (lib/vatin.ts
// only). The receipt page can import it; lib/bookamat.ts (supabaseAdmin) and
// lib/ai-extractor.ts (the Anthropic client) re-export what moved here, so their
// imports stay.
import { counterpartyVatin, isOwnVatin } from './vatin'

// Austria's VAT rates: 20, 13, 10 and, since 1.7.2026, 4.9 % (basic foods). No other EU
// state uses 4.9. 0 % is no rate of its own here: a 0 % line says nothing about where the
// VAT comes from. The fallback where a tax account's own rates are not known (allowedRates).
export const AT_VAT_RATES: readonly number[] = [20, 13, 10, 4.9]

// The USt rates bookamat takes on a tax account, read from the account's `tax_values`
// („20.00“, „4.90“; bookamat refuses any other: „tax percent value is not allowed“),
// distinct and highest first. null = not known: no list, an empty one, or only ""
// („Vorsteuer Rückforderung EU/Drittland“ take any rate). A value that is no number is
// left out.
export function allowedRates(account: { tax_values?: readonly unknown[] | null } | null | undefined): number[] | null {
  const raw = account?.tax_values
  if (!Array.isArray(raw)) return null
  const rates: number[] = []
  for (const v of raw) {
    const n = typeof v === 'number' ? v
      : typeof v === 'string' && /^\d+(?:[.,]\d+)?$/.test(v.trim()) ? Number(v.trim().replace(',', '.'))
      : NaN
    if (Number.isFinite(n) && n >= 0 && !rates.includes(n)) rates.push(n)
  }
  return rates.length ? rates.sort((a, b) => b - a) : null
}

// Moved from lib/bookamat.ts (re-exported there, unchanged): common non-ISO country codes
// to the ISO-3166 alpha-2 codes bookamat accepts. The AI sometimes emits "UK" (invalid)
// instead of "GB", or "EL" for Greece. Everything else is passed through upper-cased.
const COUNTRY_ALIASES: Record<string, string> = { UK: 'GB', EL: 'GR', EN: 'GB' }
export function normalizeCountry(c: string | null | undefined): string {
  const up = (c || '').trim().toUpperCase()
  return COUNTRY_ALIASES[up] ?? up
}

// A two-letter country code as bookamat takes it (after normalizeCountry: 'uk' → GB, 'el'
// → GR), else '' — 'Austria', 'AUT', 'D', '', null and anything not a string are none.
// No full ISO list is kept: two letters pass.
export function isoCountry(c: unknown): string {
  if (typeof c !== 'string') return ''
  const n = normalizeCountry(c)
  return /^[A-Z]{2}$/.test(n) ? n : ''
}

// Moved from lib/ai-classifier.ts: the EU member states other than Austria (ISO codes;
// Greece is GR, its VAT IDs say EL).
export const EU_COUNTRY_CODES: ReadonlySet<string> = new Set([
  'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE',
  'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
])

// The home rates, as of 2026, of the EU states whose rates coincide with an Austrian one
// (20, 13, 10, 4.9 — only those overlaps matter), keyed by the country countryFromVatin
// names (Greece is GR, its VAT IDs say EL). Such a state's VAT at such a rate is its own:
// a Paris hotel at 10 %, a French shop at 20 %, a Split hotel at 13 % — not Austrian VAT
// charged under OSS.
export const EU_OWN_RATES: Readonly<Record<string, readonly number[]>> = {
  BG: [20, 9], EE: [24, 13, 9], ES: [21, 10, 4], FI: [25.5, 14, 13.5, 10], FR: [20, 10, 5.5, 2.1],
  GR: [24, 13, 6], HR: [25, 13, 5], IT: [22, 10, 5, 4], PT: [23, 13, 6],
}

// Austrian VAT charged under an EU state's UID — an EU seller without an ATU number
// (OSS, decisions M1): VAT shown, every rate an Austrian one (the year's „Vorsteuer
// Inland“ rates when the caller has them), none of them a rate of the UID's own state.
// The one test both jobs use (Job 1's foreign-VAT verdict, the Belege form's note); each
// caller leaves restaurants out — a meal's VAT is always its own country's.
export function looksOss(uidCountry: string, rates: readonly number[], atRates: readonly number[] = AT_VAT_RATES): boolean {
  return EU_COUNTRY_CODES.has(uidCountry) && rates.length > 0 && rates.every(r => atRates.includes(r)) &&
    !rates.some(r => (EU_OWN_RATES[uidCountry] ?? []).includes(r))
}

// Moved from lib/ai-extractor.ts (re-exported there, unchanged). Only a recognised foreign
// currency counts: „Euro“, „EURO“, „N/A“ or „unknown“ are taken as euros, as before the
// field existed.
export function isForeignCurrency(currency: string | null | undefined): boolean {
  const cur = (currency ?? '').toString().trim().toUpperCase()
  return (/^[A-Z]{3}$/.test(cur) && cur !== 'EUR') || /[$£¥₣₤₹]/.test(cur)
}

// A VAT ID prefix that is not the ISO code of its country
const VATIN_PREFIX_COUNTRY: Record<string, string> = { EL: 'GR' }

// The country a supplier's VAT ID (UID) names — from a complete one only, since a
// half-typed value says nothing (the Belege form reads the field on every keystroke).
// Spaces, dots and hyphens don't count; case doesn't matter:
// - ATU and 8 digits → AT;
// - an EU state's prefix with 8 to 12 letters or digits after it → that state (EL → GR);
// - GB with 9 or 12 digits → GB; CHE with 9 digits (+ MWST/TVA/IVA) → CH; NO with 9
//   digits (+ MVA) → NO.
// '' for anything else: none, a bare prefix or a half-typed number („ATU7“), AT without
// the U, the non-Union OSS number (EU…), a US tax number, and XI: Northern Ireland counts
// as EU for goods but not for services, so no country (and no region) is derived from it.
// The owner's own UID is never the supplier's (counterpartyVatin): ''.
export function countryFromVatin(raw: string | null | undefined): string {
  const v = counterpartyVatin(raw).replace(/[\s.\-]/g, '').toUpperCase()
  if (!v) return ''
  if (/^ATU\d{8}$/.test(v)) return 'AT'
  if (/^GB(?:\d{9}|\d{12})$/.test(v)) return 'GB'
  if (/^CHE\d{9}(?:MWST|TVA|IVA)?$/.test(v)) return 'CH'
  if (/^NO\d{9}(?:MVA)?$/.test(v)) return 'NO'
  const m = /^([A-Z]{2})[0-9A-Z]{8,12}$/.exec(v)
  if (!m) return ''
  const country = VATIN_PREFIX_COUNTRY[m[1]] ?? m[1]
  return EU_COUNTRY_CODES.has(country) ? country : ''
}

export type VatOrigin = {
  origin: 'AT' | 'foreign' | 'unknown'
  country: string                  // the country that decided ('AT', 'DE' …); '' when unknown
  uidCountry: string               // countryFromVatin(vatin): the UID's own country, '' for none
  basis: 'atu-uid' | 'country' | 'uid' | 'none'
}

// Whose VAT a supplier charges, by its country (as read: an address, the Herkunftsland
// field, the model's answer) and its UID, in this order:
// 1. an Austrian UID (ATU…) → Austrian VAT, whatever the address says (Amazon EU S.à r.l.:
//    LU address, ATU73569248, 20 % Austrian VAT);
// 2. an Austrian country → Austrian: a foreign UID does not move an Austrian seat (NUKI:
//    Graz, with a German UID too);
// 3. an EU state's UID → that state, also over a different foreign address (a marketplace
//    seller with a CN address and a PL UID is PL): VAT is charged under the UID;
// 4. another country that was read → that country (a GB or CH UID does not move it);
// 5. a UID alone (GB, CH, NO) → its country;
// 6. else unknown — the caller decides.
// The owner's own UID never counts (countryFromVatin).
export function vatOrigin(country: string | null | undefined, vatin: string | null | undefined): VatOrigin {
  const uidCountry = countryFromVatin(vatin)
  const read = isoCountry(country)
  if (uidCountry === 'AT') return { origin: 'AT', country: 'AT', uidCountry, basis: 'atu-uid' }
  if (read === 'AT') return { origin: 'AT', country: 'AT', uidCountry, basis: 'country' }
  if (EU_COUNTRY_CODES.has(uidCountry) && read !== uidCountry) return { origin: 'foreign', country: uidCountry, uidCountry, basis: 'uid' }
  if (read) return { origin: 'foreign', country: read, uidCountry, basis: 'country' }
  if (uidCountry) return { origin: 'foreign', country: uidCountry, uidCountry, basis: 'uid' }
  return { origin: 'unknown', country: '', uidCountry, basis: 'none' }
}

// A supplier's region as the classifier's supplier_region names it, from its country
// (normalised first: EL is Greece, UK is GB): '' and AT are Austria, an EU state is EU,
// anything else a third country.
export function regionOfCountry(c: string | null | undefined): 'AT' | 'EU' | 'third_country' {
  const n = normalizeCountry(c)
  if (!n || n === 'AT') return 'AT'
  if (EU_COUNTRY_CODES.has(n)) return 'EU'
  return 'third_country'
}

// The supplier's Austrian UID in a receipt's text: every „ATU“ with 8 digits (single
// spaces between them allowed; not one of a longer number), the owner's own left out
// (it is printed on every invoice he receives). The one number left, else '' — none, or
// several different ones: whose is whose is not ours to guess.
export function supplierAtuInText(text: string | null | undefined): string {
  const found: string[] = []
  for (const m of Array.from((text || '').matchAll(/ATU\s?(?:\d\s?){7}\d(?!\d)/gi))) {
    const uid = m[0].replace(/\s/g, '').toUpperCase()
    if (!isOwnVatin(uid) && !found.includes(uid)) found.push(uid)
  }
  return found.length === 1 ? found[0] : ''
}
