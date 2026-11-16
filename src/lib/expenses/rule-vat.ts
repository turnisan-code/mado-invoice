// A Buchungsregel's USt-Satz in the rule editor (app/(app)/vendors/page.tsx): the rates it
// offers, how a rate reads, and what the editor says after a save. A rule's rows book its
// rate as stored (lib/row-defaults.ts; „4.90“ in the payload), and lib/booking-validation.ts
// checks it against the rates each tax account takes.
//
// Whether the column vendors.tax_percent keeps decimals is not known (the schema SQL in
// lib/supabase.ts is stale, P2-18): an integer column refuses 4,9, and numeric(p,0) rounds
// it to 5 without a word. So every save is read back, and a refusal names the rate
// (decision D4).
//
// Pure and client-safe: the rule editor and the tests share it.
import { AT_VAT_RATES } from './vat-origin'

// The editor's choices: Austria's rates (20, 13, 10 and, since 1.7.2026, 4,9 %) and 0 %
export const RULE_VAT_RATES: readonly number[] = [...AT_VAT_RATES, 0]

const RULE_VAT_LABELS: Record<string, string> = {
  '20': '20% (Standard)',
  '13': '13% (ermäßigt)',
  '10': '10% (ermäßigt)',
  '4.9': '4,9% (ermäßigt)',
  '0': '0% (steuerfrei/IG)',
}

// A rate as the owner reads it: „4,9“, „20“ — at most two decimals, with a comma
export function rateLabel(v: unknown): string {
  const n = Number(v)
  return String(Number.isFinite(n) ? Math.round(n * 100) / 100 : 0).replace('.', ',')
}

// An option's text: an offered rate by its name, any other stored rate as itself
// („19% (gespeichert)“: a rule imported from bookamat, or a rate Supabase rounded)
export const ruleVatLabel = (v: number): string =>
  RULE_VAT_LABELS[String(v)] ?? `${rateLabel(v)}% (gespeichert)`

// The select's options for the rule's own rate. A rate the editor does not offer gets an
// option of its own: without one the select shows „20% (Standard)“, its first, while the
// rule books its own rate.
export const ruleVatOptionsFor = (v: number): readonly number[] =>
  RULE_VAT_RATES.includes(v) ? RULE_VAT_RATES : [...RULE_VAT_RATES, v].sort((a, b) => b - a)

// A number, or a numeric text („4.90“); null for anything else
function asRate(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number(v) : NaN
  return Number.isFinite(n) ? n : null
}

// A saved rule read back: the rate Supabase stored against the one sent, compared in
// hundredths as bookamat books them. null when they agree, or when the answer carries no
// rate. `name` says which rule when several are saved at once (the import from bookamat).
export function storedRateNote(sent: unknown, stored: unknown, name?: string): string | null {
  const s = asRate(stored)
  const y = asRate(sent)
  if (s == null || y == null || Math.round(s * 100) === Math.round(y * 100)) return null
  return `Regel${name ? ` „${name}“` : ''} gespeichert, aber mit ${rateLabel(s)} % statt ${rateLabel(y)} % USt — Supabase rundet den Satz (Spalte vendors.tax_percent). Satz prüfen, bevor die Regel bucht.`
}

// A save the server refused, with the rate it carried: an integer column refuses 4,9
// („invalid input syntax for type integer: "4.9"“), never without a word
export const ruleNotSavedText = (rate: unknown, error: string): string =>
  `Regel mit ${rateLabel(rate)} % USt nicht gespeichert — ${error}`
