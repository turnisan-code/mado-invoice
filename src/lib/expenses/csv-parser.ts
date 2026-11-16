// Ported from Bookmatic lib/csv-parser.ts (475072f): the easybank rows as Bookmatic's
// expense engine reads them (EasybankTransaction: the gross amount, the type, the
// counterparty and the raw cells col0…col5). Papaparse is replaced by Mado's RFC 4180
// splitter (lib/bank/parse.ts splitCsv); the logic per row is unchanged. Mado's own
// parser (lib/bank/parse.ts) reads the same file for the „Einnahmen“ tab.
import { parse, isValid, format } from 'date-fns'
import { splitCsv } from '@/lib/bank/parse'
import type { EasybankTransaction } from '@/lib/expenses/types'

// Papaparse's `skipEmptyLines: true`: a line with nothing in it is no row
const rowsOf = (text: string, delimiter: string): string[][] =>
  splitCsv(text, delimiter).filter(row => !(row.length === 1 && row[0] === ''))

// Papaparse's `header: true`: the first row names the cells of every other row
function recordsOf(text: string, delimiter: string): Record<string, string>[] {
  const [header, ...rows] = rowsOf(text, delimiter)
  if (!header) return []
  return rows.map(row => Object.fromEntries(header.map((h, i) => [h, row[i] ?? ''])))
}

// easybank CSV format (no headers):
// Col 0: IBAN
// Col 1: Buchungstext (counterparty + reference, pipe-separated)
// Col 2: Buchungsdatum
// Col 3: Valutadatum
// Col 4: Betrag
// Col 5: Währung

// The receipt-amount check (gross or net of SPESEN, compared in cents) moved to the
// package-free lib/money.ts; re-exported for existing imports.
export { amountMatchesTransaction } from './money'

function parseAmount(raw: string): number {
  const cleaned = raw
    .replace(/[^\d,.\-]/g, '')
    .replace(/\.(?=\d{3})/g, '')  // remove thousands separator
    .replace(',', '.')             // decimal comma → point
  return parseFloat(cleaned) || 0
}

// easybank bundles card/foreign fees into the debit and records them as
// "SPESEN: X,XX" in the Buchungstext (occasionally without the colon). The
// merchant invoice is for the goods amount (gross − fee), so we surface the
// fee to make receipt matching work regardless of merchant (PayPal, Klarna,
// Revolut card, …).
function parseFee(buchungstext: string): number {
  const m = buchungstext.match(/SPESEN\s*:?\s*([\d.,]+)/i)
  if (!m) return 0
  return parseAmount(m[1])
}

// dd.MM.yyyy is the only format easybank actually exports (checked first, so it
// always wins when present). The slash formats below are an ambiguous fallback
// for other bank exports reaching the header-based parser — dd/MM and MM/dd
// can both match the same string (e.g. "03/06/2026"), so a slash date isn't
// pinned to one true reading. Kept only as a last resort; callers should treat
// a null return (nothing matched) as a hard parse failure, not a guess.
function parseDate(raw: string): string | null {
  const formats = ['dd.MM.yyyy', 'yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy']
  for (const fmt of formats) {
    const parsed = parse(raw.trim(), fmt, new Date())
    if (isValid(parsed)) {
      // format() uses local calendar date — toISOString() would shift the date
      // back a day in timezones ahead of UTC (parser now also runs client-side)
      return format(parsed, 'yyyy-MM-dd')
    }
  }
  return null
}

function parseHeaderlessEasybank(csvContent: string): {
  transactions: EasybankTransaction[]
  errors: string[]
} {
  const result = { data: rowsOf(csvContent, ';') }

  const transactions: EasybankTransaction[] = []
  const errors: string[] = []

  for (let rowIndex = 0; rowIndex < result.data.length; rowIndex++) {
    const row = result.data[rowIndex]
    const lineNo = rowIndex + 1
    const rawLine = row.join(';').slice(0, 100)

    if (row.length < 5) {
      errors.push(`Zeile ${lineNo} übersprungen — zu wenige Spalten (${row.length} statt mind. 5): "${rawLine}"`)
      continue
    }

    // Skip header rows if present — expected, not a parse failure
    if (row[0]?.toLowerCase().includes('iban') || row[2]?.toLowerCase().includes('datum')) continue

    const buchungstext = row[1]?.trim() || ''
    const rawDate = row[2]?.trim() || ''
    const rawAmount = row[4]?.trim() || ''
    const currency = row[5]?.trim() || 'EUR'

    const date = parseDate(rawDate)
    const amount = parseAmount(rawAmount)

    // A transaction that fails to parse must never just vanish — every skip is
    // reported so the user can compare "N Transaktionen" against the source
    // file instead of silently losing a taxable transaction.
    if (!date) {
      errors.push(`Zeile ${lineNo} übersprungen — Datum "${rawDate}" nicht lesbar: "${rawLine}"`)
      continue
    }
    if (isNaN(amount) || amount === 0) {
      errors.push(`Zeile ${lineNo} übersprungen — Betrag "${rawAmount}" ungültig oder null: "${rawLine}"`)
      continue
    }
    const txType: 'income' | 'expense' = amount > 0 ? 'income' : 'expense'

    // Extract counterparty: last pipe-separated segment that looks like a company name
    // Format: "Abbuchung Dauerauftrag   BG/...|BAWAATWWXXX IBAN Name|Verwendungszweck"
    // Or:     "Magenta Festnetz Rechnung 916600040426 vom 07.04.2026 - D|etails...|OG/...|BKAUATWWXXX..."
    // Income: "Gutschrift|NTSBDEB1XXX DE361... Konrad Testmann|RN-202605010" → need "Konrad Testmann"
    const parts = buchungstext.split('|')

    // The counterparty name is usually the last segment containing a company/person name
    // Try to find the most meaningful part
    let counterparty = ''
    let bicIbanName = ''   // name extracted from "BIC IBAN Name" segments
    const reference = buchungstext  // store full text as reference for invoice number extraction

    // Look for company name — typically last segment with letters after IBAN
    const ibanPattern = /^[A-Z]{2}\d{2}/
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i].trim()
      // Skip IBAN-like segments (AT12...)
      if (ibanPattern.test(part)) continue
      // Skip BIC+IBAN segments — handles both pure-letter (BKAUATWWXXX) and alphanumeric
      // (REVOLT21XXX, SPPBAT21034) BICs where location/branch codes include digits.
      // Standard BIC: 4-letter bank + 2-letter country + 2-char location + optional 3-char branch
      // IMPORTANT: only treat this as a BIC when it's immediately followed by a real IBAN
      // (2-letter country + 10-30 digits) — the bare 8-11-char uppercase shape alone also
      // matches ordinary all-caps company names (e.g. "MEDIAMARKT GMBH" — 10 uppercase
      // letters), which would otherwise be silently discarded as if it were a bank code.
      // A bare BIC with nothing else in the segment (no IBAN/name following) is a much
      // narrower, safer match than the shape alone — a real bank code occupying an
      // entire pipe segment by itself, vs. any 8-11 char uppercase prefix of a longer string.
      const isBareBic = /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}$/.test(part)
      if (/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}\s+[A-Z]{2}\d{10,30}/.test(part) || isBareBic) {
        if (!bicIbanName) {
          const m = part.match(/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}\s+[A-Z]{2}\d{10,30}\s+(.+)/)
          if (m) bicIbanName = m[1].trim()
        }
        continue
      }
      // Skip SPESEN segments — colon is optional (see parseFee above)
      if (/^SPESEN\s*:?/i.test(part)) continue
      // Skip order/document refs: OG/, BG/, MC/, VD/, FE/
      if (/^(OG|BG|MC|VD|FE)\/\d+/.test(part)) continue
      // Skip invoice-reference-like segments (payment description, not a counterparty name)
      // e.g. "RN-202605010", "RE-2026-001", "VD/000000585"
      if (/^(RN|RE|RG)[_\-\/]/i.test(part)) continue
      // Skip pure-digit segments — these are payment reference numbers (e.g. "202603005")
      if (/^\d+$/.test(part)) continue
      // Skip segments starting with a long digit sequence — ref codes mixed with text
      // e.g. "202603005 FE/000000553", "0000302755/MIETE 03/26/02.06.2026/MIETE"
      if (/^\d{5,}/.test(part)) continue
      // Skip empty or very short
      if (part.length < 3) continue
      // Found a meaningful segment
      counterparty = part
      break
    }

    // If we got a URL-like result (looks like a real domain), it's not a company name.
    // Require 3+ char segments to avoid clearing abbreviations like "Akad.f.Kunst"
    if (counterparty && /[a-zA-Z]{3,}\.[a-zA-Z]{3,}\.[a-zA-Z]{2,}/.test(counterparty)) counterparty = ''

    // For income transactions: the payer's name is always in the BIC+IBAN segment.
    // Prefer it unconditionally — "Gutschrift Echtzeitüberweisung FE/000000572" is just
    // a generic payment descriptor, not the actual sender name.
    // For expense transactions: use bicIbanName only as fallback if nothing else found.
    if (txType === 'income' && bicIbanName) {
      counterparty = bicIbanName
    } else if (!counterparty && bicIbanName) {
      counterparty = bicIbanName
    }

    // Fallback: extract first meaningful word group from start of buchungstext
    // e.g. "Magenta Festnetz Rechnung..." → "Magenta Festnetz"
    // e.g. "Abbuchung Dauerauftrag   BG/..." → skip to last pipe segment
    if (!counterparty) {
      const cleaned = buchungstext.replace(/\s+/g, ' ').trim()
      // Try: last pipe segment before order refs
      const allParts = buchungstext.split('|')
      for (let i = allParts.length - 1; i >= 0; i--) {
        const seg = allParts[i].trim()
        if (seg.length > 5 &&
            !/^[A-Z]{2}\d{2}/.test(seg) &&
            !/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2,5}\s+[A-Z]{2}\d{10,30}/.test(seg) &&
            !/^(OG|BG|MC|VD|FE)\//.test(seg) &&
            !/^SPESEN/i.test(seg) &&
            !/\.\w+\./.test(seg) &&
            !/^(RN|RE|RG)[_\-\/]/i.test(seg) &&
            !/^\d+$/.test(seg) &&
            !/^\d{5,}/.test(seg)) {
          counterparty = seg.substring(0, 50)
          break
        }
      }
      // Last resort: first 40 chars of buchungstext
      if (!counterparty) counterparty = cleaned.substring(0, 40)
    }

    const gross = Math.abs(amount)
    const fee = parseFee(buchungstext)
    transactions.push({
      date,
      counterparty,
      amount: gross,
      type: txType,
      currency,
      reference,
      raw: Object.fromEntries(row.map((v, i) => [`col${i}`, v])),
      ...(fee > 0 && fee < gross ? { fee, net_amount: Math.round((gross - fee) * 100) / 100 } : {}),
    })
  }

  return { transactions, errors }
}

export function parseEasybankCsv(csvContent: string): {
  transactions: EasybankTransaction[]
  errors: string[]
} {
  // Check if first row looks like it has no headers (starts with AT/IBAN or is raw data)
  const firstLine = csvContent.trim().split('\n')[0]
  const isHeaderless = /^[A-Z]{2}\d{2}/.test(firstLine.trim()) ||
    firstLine.split(';').length >= 5 && !firstLine.toLowerCase().includes('datum')

  if (isHeaderless) {
    return parseHeaderlessEasybank(csvContent)
  }

  // Fallback: try header-based parsing
  const errors: string[] = []

  let result = { data: recordsOf(csvContent, ';') }
  if (result.data.length === 0 || Object.keys(result.data[0] as object).length <= 1) {
    result = { data: recordsOf(csvContent, ',') }
  }

  if (result.data.length === 0) {
    return { transactions: [], errors: ['Could not parse CSV — unrecognized format'] }
  }

  const headers = Object.keys(result.data[0] as object)
  const dateCol = headers.find(h => /buchungsdatum|datum|date/i.test(h)) || null
  const counterpartyCol = headers.find(h => /buchungstext|auftraggeber|empf|name/i.test(h)) || null
  const amountCol = headers.find(h => /betrag|amount|umsatz/i.test(h)) || null
  const currencyCol = headers.find(h => /währung|currency/i.test(h)) || null

  if (!dateCol || !amountCol) {
    return { transactions: [], errors: ['Could not find required columns in CSV'] }
  }

  const transactions: EasybankTransaction[] = []

  for (let rowIndex = 0; rowIndex < result.data.length; rowIndex++) {
    const row = result.data[rowIndex] as Record<string, string>
    const lineNo = rowIndex + 1
    const date = dateCol ? parseDate(row[dateCol]) : null
    const amount = amountCol ? parseAmount(row[amountCol]) : 0
    const counterparty = counterpartyCol ? row[counterpartyCol]?.trim() : 'Unknown'
    const currency = currencyCol ? row[currencyCol]?.trim() : 'EUR'

    if (!date) {
      errors.push(`Zeile ${lineNo} übersprungen — Datum "${dateCol ? row[dateCol] : ''}" nicht lesbar`)
      continue
    }
    if (isNaN(amount) || amount === 0) {
      errors.push(`Zeile ${lineNo} übersprungen — Betrag "${amountCol ? row[amountCol] : ''}" ungültig oder null`)
      continue
    }

    transactions.push({
      date,
      counterparty: counterparty || 'Unknown',
      amount: Math.abs(amount),
      type: amount > 0 ? 'income' : 'expense',
      currency: currency || 'EUR',
      reference: row['Verwendungszweck'] || row['Reference'] || counterparty || '',
      raw: row,
    })
  }

  return { transactions, errors }
}
