import { roundCents } from '../utils/number'
import type { BankTransaction } from './types'

export interface OpenInvoice {
  id: string
  number: string
  clientName: string
  clientCompany: string | null
  date: string
  dueDate: string | null
  total: number
  paid: number
  balance: number
  skontoPercent: number | null
  skontoDays: number | null
  /** Highest dunning level sent: a credit above the balance then most likely includes fees and interest. */
  reminderLevel: number
}

export type MatchStatus = 'match' | 'unmatched' | 'debit' | 'imported' | 'nothing_open'
export type MatchReason = 'number' | 'amount' | 'total' | 'skonto' | 'name'
export type MatchConfidence = 'high' | 'medium'

export interface MatchRow {
  transaction: BankTransaction
  status: MatchStatus
  invoiceId: string | null
  confidence: MatchConfidence | null
  score: number
  reasons: MatchReason[]
  /** Skonto to record alongside the payment when a Skonto settlement is detected, else 0. */
  skontoAmount: number
  amountToRecord: number
}

const alnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '')

const escapeRe = (c: string) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Short words a payer puts before a bare invoice number ("Rechnung Nr. 2026-001", "Zahlung für
// 2026-001", "HN 2026-001"). Other one- or two-letter runs directly before the digits ("A-2026-003",
// "G-2026-001", "KD2026001") are another document's prefix, so the digits are not this invoice.
const ALLOWED_WORDS = new Set(['R', 'RE', 'RG', 'RN', 'HN', 'FT', 'NR', 'NO', 'N', 'ID', 'U', 'ZU', 'FA', 'VS', 'TZ', 'ER', 'AR', 'LT', 'OF', 'TO'])

// Labels of numbers that are never the invoice number: other document types, the payer's own
// references, bank and tax identifiers, phone numbers, currencies. Short labels match as whole words
// (so "Abrechnung" and "Pollak" are not AB or PO), long ones as word stems ("Bestellnummer").
const DENIED_WORDS = new Set([
  'KV', 'KVA', 'GS', 'PO', 'AB', 'LS', 'KD', 'KDNR', 'BIC', 'TEL', 'TAX', 'ACC', 'ACCT', 'EUR', 'EURO', 'UID', 'ATU', 'BLZ',
  'VAT', 'FAX', 'CHF', 'USD', 'GBP', 'MREF', 'STNR', 'SVNR', 'IBAN', 'MOBIL', 'MOBILNR', 'CREDIT', 'CREDITNOTE',
  // Abbreviated document and reference labels: "Ang. 2026-003", "Best.-Nr. 2026-001", "Auftr. 2026-001".
  'ANG', 'ANGEB', 'GUTSCHR', 'BEST', 'BESTNR', 'AUFTR', 'AUFTRNR', 'PROJ', 'PROJNR', 'VERTR', 'MITGL', 'EST', 'CUST',
])
const DENIED_STEMS = [
  'ANGEBOT', 'OFFERT', 'KOSTENVORANSCHLAG', 'QUOTE', 'ESTIMATE', 'GUTSCHRIFT', 'STORNO', 'BESTELL', 'AUFTRAG',
  'ORDER', 'LIEFERSCHEIN', 'PROJEKT', 'PROJECT', 'VERTRAG', 'CONTRACT', 'KUNDE', 'CUSTOMER', 'CLIENT', 'MITGLIED',
  'MEMBER', 'MANDAT', 'KONTO', 'ACCOUNT', 'STEUERNR', 'TELEFON', 'MOBILTEL', 'HANDY', 'PHONE',
]
// "Angebot Nr. 2026-003": the label sits one word further back.
const NUMBER_WORDS = new Set(['NR', 'NO', 'NUMMER', 'NUM', 'NUMBER', 'NBR', 'N', 'ID'])
// After one of these the digits are the invoice number even when a currency follows ("RE 20260001 EUR").
const INVOICE_WORDS = new Set(['R', 'RE', 'RG', 'RN', 'HN', 'HNR', 'NR', 'NO', 'INV', 'REF', 'RNR', 'BILL', 'FACT', 'FAKT'])
const isInvoiceWord = (word: string) => INVOICE_WORDS.has(word) || /^(?:RECHNUNG|RECH|INVOICE|HONORAR|FAKTUR)/.test(word)

// The characters in order over the upper-cased text, any run of separators between them but no
// decimal or thousands separator between two digits, so "2026-001" is found in "RE2026-001",
// "2026/001", "2026 001" and "2026-001/2". A digit glued to either end continues the number instead
// ("2026-0012", "12026-001"), and a number that starts with its letter prefix must not continue a word
// ("Honorar 12" is not R12).
const gapPattern = (chars: string[]) => chars.map((c, i) => {
  const gap = i === 0 ? '' : /[0-9]/.test(chars[i - 1]) && /[0-9]/.test(c) ? '[^\\p{L}\\p{N}.,]*' : '[^\\p{L}\\p{N}]*'
  return gap + escapeRe(c)
}).join('')

interface NumberMatcher {
  full: RegExp
  /** The number without its letter prefix, when that is long enough to stand alone. */
  digits: RegExp | null
  prefix: string
  /** Fewer than four digits: a hit is a coincidence often enough to stay medium confidence. */
  short: boolean
}

// Numbers under three characters ("R1") would turn up everywhere; those count on amount and name only.
function numberMatcher(raw: string): NumberMatcher | null {
  const number = alnum(raw)
  if (number.length < 3) return null
  const prefix = number.match(/^[A-Z]+/)?.[0] ?? ''
  const digitPart = number.slice(prefix.length)
  const full = new RegExp(`(?<![${prefix ? '\\p{L}\\p{N}' : '0-9'}])${gapPattern(number.split(''))}(?![0-9])`, 'gu')
  // Payers usually leave the prefix out ("Rechnung 2026-001" for R-2026-001): the digit part alone
  // counts too when it is long enough not to be a coincidence.
  const digits = prefix && digitPart.length >= 5 ? new RegExp(`(?<![0-9])${gapPattern(digitPart.split(''))}(?![0-9])`, 'gu') : null
  return { full, digits, prefix, short: digitPart.replace(/[^0-9]/g, '').length < 4 }
}

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c)

// The letters directly before a position, skipping separators; a backwards scan so a long run of
// separators costs nothing.
function trailingWord(text: string): { word: string; start: number } {
  let end = text.length
  while (end > 0 && !isWordChar(text[end - 1])) end--
  let start = end
  while (start > 0 && /\p{L}/u.test(text[start - 1])) start--
  return { word: text.slice(start, end), start }
}

interface FindOptions { ownPrefix: string; otherPrefixes: Set<string> }

// `unknownShort`: an unknown one- or two-letter word counts as a prefix directly before the digits
// or before a number word ("A Nr. 2026-003"); before a separate number ("KW 09 2026-001") it is a word.
function isDeniedLabel(word: string, { ownPrefix, otherPrefixes }: FindOptions, unknownShort = true): boolean {
  if (!word || word === ownPrefix) return false
  if (otherPrefixes.has(word) || DENIED_WORDS.has(word) || DENIED_STEMS.some(stem => word.startsWith(stem))) return true
  return unknownShort && word.length <= 2 && !ALLOWED_WORDS.has(word)
}

// Finds the invoice number in a remittance text and rules out digits that belong to something else:
// a date ("12.03.2026 100,00" is not invoice 2026-100, "2026-03-12" is not 20260312), an unfinished
// IBAN, a phone number, another document's number or the payer's own reference, or an amount.
// `split` reports a number whose digits were only found with whitespace in between, which is weaker
// evidence than "2026-001" or "2026001".
function findNumber(text: string, re: RegExp, options: FindOptions): { split: boolean } | null {
  const upper = text.toUpperCase()
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(upper))) {
    const hit = m[0]
    // Every rule below looks at the hit's immediate surroundings, so a long text costs nothing extra.
    const before = upper.slice(Math.max(0, m.index - 64), m.index)
    const after = upper.slice(m.index + hit.length, m.index + hit.length + 16)
    const split = /\d\D*\s\D*\d/.test(hit)
    const bare = /^\d+$/.test(hit)
    const { word, start } = trailingWord(before)
    if (/^\d{4}[-/. ]\d{1,2}[-/. ]\d{1,2}$/.test(hit)) continue
    if (/^[0-9]/.test(hit)) {
      if (/(?<!\d)\d{1,2}[./]\s*$/.test(before)) continue
      // Up to three groups after the check digits: the IBAN is not complete, the hit continues it.
      if (/IBAN[\s:]*[A-Z]{2}\s*\d{2}(?:\s*\d{4}){0,3}\s*$/.test(before)) continue
      if (/^\d{4}(?:\s\d{4})+$/.test(hit) && /(?<!\p{L})[A-Z]{2}\d{2}(?:\s+\d{4}){0,3}\s+$/u.test(before)) continue
      // A phone prefix right before the digits: "0664/2026001", "+43 664 2026001", "01/2026001".
      if (/(?:^|[^\d\-/.])(?:(?:\+|00)\d{2,3}\s*(?:\(0\)\s*)?\d{2,4}\s*[/ -]*|06\d{2}\s*[/ -]*|0\d{1,4}\s*[/-]\s*)$/.test(before)) continue
      if (isDeniedLabel(word, options)) continue
      if (NUMBER_WORDS.has(word) && isDeniedLabel(trailingWord(before.slice(0, start)).word, options)) continue
      // "Tel 01 2026001", "Kundennummer 12345 2026001": the label sits before a separate number.
      const beforeNumber = word ? before : before.replace(/(?<!\p{L})\p{N}+[^\p{L}\p{N}]*$/u, '')
      if (beforeNumber !== before && isDeniedLabel(trailingWord(beforeNumber).word, options, false)) continue
    }
    if ((split || bare) && /^[,.](?:\d{2}(?!\d)|-)/.test(after)) continue
    // A plain digit run next to a currency is an amount ("Betrag 26001 EUR", "€ 26001"), unless the
    // currency introduces an amount of its own ("RE 20260001 EUR 100,00").
    if (bare && !isInvoiceWord(word) && (/^\s*(?:€|EURO?\b)(?!\s*\d)/.test(after) || /€\s*$/.test(before))) continue
    return { split }
  }
  return null
}

// Legal forms and filler words carry no identity: "GmbH" or "und" would match every company.
const NOISE = new Set(['gmbh', 'eu', 'kg', 'og', 'ag', 'ltd', 'inc', 'llc', 'mbh', 'und', 'and', 'the', 'der', 'die', 'das', 'von', 'van'])

// Letters only, lower case, umlauts transliterated the way bank statements print them.
export function nameTokens(s: string | null | undefined): Set<string> {
  if (!s) return new Set()
  const flat = s.toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
  return new Set(flat.split(/[^a-z]+/).filter(t => t.length >= 3 && !NOISE.has(t)))
}

function addDaysIso(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

export interface MatchOptions {
  /** Prefixes of the other document types (quote, credit note): their numbers are never an invoice. */
  otherPrefixes?: string[]
}

export function matchTransactions(transactions: BankTransaction[], invoices: OpenInvoice[], importedRefs: Set<string>, options: MatchOptions = {}): MatchRow[] {
  const otherPrefixes = new Set((options.otherPrefixes ?? []).map(alnum).filter(Boolean))
  const open = invoices.filter(i => i.balance > 0.005)
  // Running balance: an invoice can absorb several credits only while something is still open.
  const remaining = new Map(open.map(i => [i.id, i.balance]))
  const clientTokens = new Map(open.map(i => [i.id, nameTokens(`${i.clientName} ${i.clientCompany ?? ''}`)]))
  const matchers = new Map(open.map(i => [i.id, numberMatcher(i.number)]))
  const rows: MatchRow[] = []

  for (const tx of transactions) {
    const base: Omit<MatchRow, 'status'> = { transaction: tx, invoiceId: null, confidence: null, score: 0, reasons: [], skontoAmount: 0, amountToRecord: tx.amount }
    if (importedRefs.has(tx.id)) { rows.push({ ...base, status: 'imported' }); continue }
    if (tx.amount <= 0) { rows.push({ ...base, status: 'debit' }); continue }
    if (!open.length) { rows.push({ ...base, status: 'nothing_open' }); continue }

    // Text and reference are searched separately so a number cannot span the two fields.
    const haystacks = [tx.text, tx.reference ?? ''].filter(Boolean)
    const counterparty = nameTokens(tx.counterparty)
    let best: { inv: OpenInvoice; score: number; reasons: MatchReason[]; skonto: number } | null = null

    for (const inv of open) {
      const balance = remaining.get(inv.id)!
      if (balance <= 0.005) continue
      const paid = roundCents(inv.total - balance)
      let score = 0
      let skonto = 0
      const reasons: MatchReason[] = []

      const matcher = matchers.get(inv.id)
      const find: FindOptions = { ownPrefix: matcher?.prefix ?? '', otherPrefixes }
      const hit = matcher
        ? haystacks.map(h => findNumber(h, matcher.full, find) ?? (matcher.digits ? findNumber(h, matcher.digits, find) : null)).find(Boolean)
        : null
      if (hit) { score += hit.split || matcher!.short ? 70 : 100; reasons.push('number') }

      if (Math.abs(tx.amount - balance) < 0.005) { score += 50; reasons.push('amount') }
      else if (balance < inv.total && Math.abs(tx.amount - inv.total) < 0.005) { score += 20; reasons.push('total') }

      if (inv.skontoPercent && inv.skontoPercent > 0 && inv.skontoDays != null && tx.date <= addDaysIso(inv.date, inv.skontoDays)) {
        const discounted = roundCents(inv.total * (1 - inv.skontoPercent / 100))
        if (Math.abs(tx.amount - roundCents(discounted - paid)) < 0.005) {
          score += 60
          reasons.push('skonto')
          skonto = roundCents(balance - tx.amount)
        }
      }

      let overlap = 0
      for (const token of counterparty) if (clientTokens.get(inv.id)!.has(token)) overlap++
      if (overlap) { score += Math.min(overlap, 2) * 20; reasons.push('name') }

      if (!best || score > best.score) best = { inv, score, reasons, skonto }
    }

    if (best && best.score >= 50) {
      remaining.set(best.inv.id, roundCents(remaining.get(best.inv.id)! - tx.amount - best.skonto))
      rows.push({
        ...base,
        status: 'match',
        invoiceId: best.inv.id,
        confidence: best.score >= 100 ? 'high' : 'medium',
        score: best.score,
        reasons: best.reasons,
        skontoAmount: best.skonto,
      })
    } else {
      rows.push({ ...base, status: 'unmatched' })
    }
  }
  return rows
}
