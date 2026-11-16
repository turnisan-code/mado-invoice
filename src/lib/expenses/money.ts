// Amounts: how the app's German texts write them („1.250,00 €“, „25,00 USD“), how two
// amounts are compared (in whole cents), which amounts a receipt's text shows, and which
// of the receipt reader's answers is an amount (moneyOf).
//
// Pure and client-safe: no import, no env variable.

// ─── Writing an amount ────────────────────────────────────────────────────────
// Thousands with „.“, cents with „,“. Built by hand, not with toLocaleString('de-AT'): that
// groups with a narrow space and depends on the runtime's ICU data, so the server and the
// page could write the same amount differently.

// Rounded to cents as toFixed(2) rounds; a negative amount keeps its „-“ unless it rounds
// to 0,00. A value that is no finite number is written as JavaScript writes it („NaN“).
function deAmount(n: number): string {
  const fixed = Math.abs(n).toFixed(2)
  const m = /^(\d+)\.(\d{2})$/.exec(fixed)
  if (!m) return `${n < 0 ? '-' : ''}${fixed}`
  const whole = m[1].replace(/\B(?=(\d{3})+(?!\d))/g, '.')
  const sign = n < 0 && fixed !== '0.00' ? '-' : ''
  return `${sign}${whole},${m[2]}`
}

// An amount in euros: „1.250,00 €“
export function eur(n: number): string {
  return `${deAmount(n)} €`
}

// An amount in another currency, written the same way, with its code: „25,00 USD“
export function amountIn(n: number, cur: string): string {
  return `${deAmount(n)} ${cur}`
}

// ─── Comparing amounts ────────────────────────────────────────────────────────
// Whole cents. Amounts are compared in cents, never as floats: Math.abs(40.50 - 40.52) is
// 0.0200000000000031, more than 0.02.
export function cents(n: number): number {
  return Math.round(n * 100)
}

// True if a receipt's or invoice's amount matches this bank row, allowing for a bundled
// bank fee: the invoice is for the goods (net = gross − SPESEN) while the bank debited the
// gross. Matches either value within `tolerance` euros, compared in cents. Moved here from
// lib/csv-parser.ts (which re-exports it, so its callers stay), so a module that must not
// import papaparse or date-fns can use it.
export function amountMatchesTransaction(
  tx: { amount: number; net_amount?: number | null },
  candidate: number,
  tolerance = 0.02,
): boolean {
  const c = cents(candidate)
  const within = Math.round(tolerance * 100)
  if (Math.abs(c - cents(tx.amount)) <= within) return true
  return tx.net_amount != null && Math.abs(c - cents(tx.net_amount)) <= within
}

// ─── An amount the receipt reader answers ─────────────────────────────────────
// The reader's money fields (lib/ai-extractor.ts: the tip, the amount charged, a line's
// Netto and MwSt) as euros rounded to cents, or null when none was read. Here, client-safe,
// so the page can read a stored reading's figures by the same rule. Money only: unlike the
// reader's `num`, a text with „%“ is never an amount, so a suggested „10 %“ is no 10 € tip.
// Taken: a finite number, or a text holding one with „€“, „EUR“ and spaces around it, and a
// decimal comma or point (at most two decimals: „1.234“ may be a thousand, so it is not
// guessed). A space inside it only between groups of three digits („1 234,56“, as generated
// PDFs write a thousand): „1 80“ may be 1,80, so it is not guessed either. Only an amount
// above 0,00 counts; with `zero` (a line's printed MwSt, which a 0 % line prints as 0,00)
// 0,00 counts too. Anything else — a negative amount, „null“, a word, true — is null.
export function moneyOf(v: unknown, { zero = false }: { zero?: boolean } = {}): number | null {
  let n: number | null = null
  if (typeof v === 'number') {
    n = Number.isFinite(v) ? v : null
  } else if (typeof v === 'string' && !v.includes('%')) {
    const s = v.replace(/€|EUR/gi, '').trim()
    if (/^(?:\d+|\d{1,3}(?:\s\d{3})+)(?:[.,]\d{1,2})?$/.test(s)) n = Number(s.replace(/\s/g, '').replace(',', '.'))
  }
  if (n === null) return null
  const c = cents(n)
  if (c > 0) return c / 100
  return zero && c === 0 ? 0 : null
}

// ─── Amounts in a text ────────────────────────────────────────────────────────
// An amount with two decimals as a receipt prints it: German „1.234,56“, English
// „1,234.56“, Swiss „1'234.50“ (or „1'234,50“), with a no-break space or a narrow one
// (U+00A0, U+202F) between groups of three digits, as generated PDFs and toLocaleString
// write it, or without a thousands separator („1234,56“, „1234.56“). Never part of a longer
// number or of a date: no digit, „.“, „,“ or „'“ right before it, and no digit, or „.“ / „,“
// with a digit, right after it („17.07.2026“). A plain space separates two numbers, not
// thousands. A no-break space before an amount (after „€“) is no part of it.
const AMOUNT_IN_TEXT = /(?<![\d.,'])(?:\d{1,3}(?:\.\d{3})+,\d{2}|\d{1,3}(?:,\d{3})+\.\d{2}|\d{1,3}(?:'\d{3})+[.,]\d{2}|\d{1,3}(?:[\u00A0\u202F]\d{3})+[.,]\d{2}|\d+[.,]\d{2})(?!\d|[.,]\d)/g
// „17.07.“: a day and a month, as an invoice writes a Leistungszeitraum („01.07.–31.07.2026“)
const DAY_MONTH = /^(\d{1,2})\.(\d{2})$/

// Every amount with two decimals a text shows, in the text's order: „Betrag 19,99 € inkl.
// 20 % USt 3,33 €“ → [19.99, 3.33]; „Menge 2 450,00“ → [450]. A date never counts, „dd.mm.“
// included. The sign is not read: „-23,45“ → [23.45].
export function amountsInText(text: string | null | undefined): number[] {
  const t = text || ''
  const amounts: number[] = []
  for (const m of Array.from(t.matchAll(AMOUNT_IN_TEXT))) {
    const s = m[0]
    const dm = DAY_MONTH.exec(s)
    if (dm && t[(m.index ?? 0) + s.length] === '.') {
      const day = Number(dm[1]), month = Number(dm[2])
      if (day >= 1 && day <= 31 && month >= 1 && month <= 12) continue
    }
    amounts.push(Number(`${s.slice(0, -3).replace(/\D/g, '')}.${s.slice(-2)}`))
  }
  return amounts
}
