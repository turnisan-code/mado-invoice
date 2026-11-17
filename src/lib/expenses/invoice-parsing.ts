/**
 * Pure parsing helpers for invoice metadata.
 *
 * These live outside matcher.ts on purpose. matcher.ts imports googleapis, pdf-parse
 * and the Anthropic SDK at module scope, so pulling it in just to exercise two string
 * functions cost ~47s per test run — slow enough that the tests would stop being run.
 * Nothing here imports a package (lib/own-transfer.ts is pure too), so it loads in
 * milliseconds, and the import page can use it.
 *
 * matcher.ts re-exports both, so existing import sites are unchanged.
 */

import type { EasybankTransaction } from '@/lib/expenses/types'
import { counterpartyAccountOf } from './own-transfer'

// The invoice number a debit's bank text names, as the vendor wrote it there
// („Muster Festnetz Rechnung 910000000777 vom 05.01.2026“ → „910000000777“), or null
const DEBIT_INVOICE_PATTERNS = [
  /Rechnung\s+(\d{6,})/i,
  /Rechnungs?(?:nummer|nr\.?)\s*[:\-]?\s*(\d{4,})/i,
  /Invoice\s+(?:No\.?\s*)?(\d{4,})/i,
  /RE[-\/](\d{4,})/i,
]
export function invoiceNumberInText(text: string | null | undefined): string | null {
  for (const pattern of DEBIT_INVOICE_PATTERNS) {
    const match = (text || '').match(pattern)
    if (match) return match[1]
  }
  return null
}

// The invoice number of a debit, from its counterparty and bank text: the Gmail search asks
// for it, and a row without a receipt books it as its Rechnungsnummer. Moved here from
// lib/matcher.ts (which re-exports it) so the receipt pick (lib/receipt-match.ts) can read
// the same number on the page too.
export function extractInvoiceNumberFromReference(transaction: Pick<EasybankTransaction, 'counterparty' | 'reference'>): string | null {
  return invoiceNumberInText(`${transaction.counterparty} ${transaction.reference}`)
}

// The words a client writes before an invoice number: RN, RE, RG, „Rg.“, „Re.“, „Re-Nr.“,
// „Rg.-Nr.“, „Rechnung“ (also „Teil-“, „Schluss-“, „Akonto-“/„A-conto-“, „Abschlags-“,
// „Anzahlungs-“, „Zwischen-“, „Endrechnung“; never „Abrechnung“ or „Verrechnung“),
// „Rechnung Nr.“, „Rechnungsnr.“, „Rechnungsnummer“ (the compounds too: „Teilrechnung Nr.“,
// „Teilrechnungs-Nr.“, „Schlussrechnungsnummer“), „Invoice (No.|Nr.|#|Number)“, „Inv.“.
// It must start a word („GRN…“, „Ihre …“ don't count), and the
// number follows after at most one of „. : # _ - /“. Shared by the owner's invoice numbers
// below and Mado's (MADO_PREFIXED). (Letters spelled out, not \p{L}: the project compiles
// for a target without the u flag.)
const WORD_START = /(?:^|[^A-Za-zÀ-ɏ\d])/
const INVOICE_WORD = /(?:(?:teil|schluss|akonto|a-?conto|abschlags|anzahlungs|zwischen|end)?rechnungs?\s*-?\s*(?:nummer|nr|no)\.?|re\s*\.?\s*-?\s*nr\.?|rg\s*\.?\s*(?:-?\s*nr\.?)?|(?:teil|schluss|akonto|a-?conto|abschlags|anzahlungs|zwischen|end)?rechnung|invoice\s*(?:number|no\.?|nr\.?|#)?|inv\.?|rn|re)/
const BEFORE_NUMBER = /\s*[.:#_\-\/]?\s*/

// After an invoice word: a run of at least six digits, or a year and a number of three
// to six digits („2025/042“, „2026-001“), read joined. Never a word, a year alone or a
// four- or five-digit token („Rechnung Oktober“, „RE 2026-15“, „Rg 1070 Wien“).
const OWN_INVOICE = new RegExp(
  `${WORD_START.source}${INVOICE_WORD.source}${BEFORE_NUMBER.source}(20\\d{2}[\\/\\-]\\d{3,6}|\\d{6,})(?!\\d)`, 'gi')
// The form of the owner's invoice numbers: YYYYMMNNN, with a plausible year and month
const OWN_NUMBER_FORM = /^20\d{2}(?:0[1-9]|1[0-2])\d{3}$/

// A bank row's texts as the readers here take them (an EasybankTransaction, or a draft's)
type BankText = { reference?: string | null; counterparty?: string | null }

// A further number listed right after one read („RN 202605006, 202606014“, „Rechnung
// 202605006 und 202606014“): after „,“ „/“ „+“ „&“ or „und“, nine digits in the owner's form
// with a year from 2020 — a client paying several invoices at once names the word once
const FURTHER_NUMBER = /^\s*(?:,|\/|\+|&|und)\s*(\d{9})(?!\d)/i
const FURTHER_FORM = /^20[2-9]\d(?:0[1-9]|1[0-2])\d{3}$/

// The numbers one reading of a bank text names, in the order they stand: after an
// invoice word, and (`parts`) a whole „|“ part in the owner's form („…|202501901“);
// `further` those listed after one of them (FURTHER_NUMBER)
function numbersIn(text: string, parts: boolean): { read: string[]; further: string[] } {
  const found: { at: number; n: string }[] = []
  const further: string[] = []
  const re = new RegExp(OWN_INVOICE.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    found.push({ at: m.index + m[0].length, n: m[1].replace(/\D/g, '') })
    for (let at = m.index + m[0].length, f; (f = FURTHER_NUMBER.exec(text.slice(at))) && FURTHER_FORM.test(f[1]); at += f[0].length) {
      further.push(f[1])
    }
  }
  if (parts) {
    let at = 0
    for (const part of text.split('|')) {
      if (OWN_NUMBER_FORM.test(part.trim())) found.push({ at: at + part.length, n: part.trim() })
      at += part.length + 1
    }
  }
  return { read: found.sort((a, b) => a.at - b.at).map(f => f.n), further }
}

/**
 * Every invoice number of the owner's that a credit's bank text names (strict): after an
 * invoice word, a run of at least six digits or a year and a number („Re. 2025/042“ →
 * „2025042“); or a whole „|“ part in his form YYYYMMNNN („…|202501901“). Never a word, a
 * year or a four- or five-digit token; never a number after another word („Auftrag …“,
 * „Kundennr. …“). `${reference}|${counterparty}` is read as it is and with each „|“
 * removed: easybank breaks its text into lines of 57 characters, and a number can be cut
 * there („RN: 2026060|14“ → „202606014“). A number read both ways is one number: the
 * reading in the owner's form wins, else the longer one. Numbers in his form come first,
 * each group in the order the text names them. Last, the further numbers listed after one
 * read (FURTHER_NUMBER: „RN 202605006, 202606014“), never before the first.
 */
export function incomeInvoiceNumbers(tx: BankText): string[] {
  const text = `${tx.reference || ''}|${tx.counterparty || ''}`
  const asIs = numbersIn(text, true)
  const out = asIs.read.filter((n, k) => asIs.read.indexOf(n) === k)
  const further = [...asIs.further]
  // The same text with one line break removed, each in turn: the other breaks still end a
  // word („X|RN 2026060|14“, „Gutschrift|Rechnungs|nr. …“)
  for (let k = text.indexOf('|'); k >= 0; k = text.indexOf('|', k + 1)) {
    const joined = numbersIn(text.slice(0, k) + text.slice(k + 1), false)
    further.push(...joined.further)
    for (const n of joined.read) {
      if (out.includes(n)) continue
      // Read differently on another reading (one starts or ends the other): the same
      // number — the reading in his form, else the longer one
      const cut = out.findIndex(p => p.startsWith(n) || p.endsWith(n) || n.startsWith(p) || n.endsWith(p))
      if (cut < 0) out.push(n)
      else if (OWN_NUMBER_FORM.test(n) || (!OWN_NUMBER_FORM.test(out[cut]) && n.length > out[cut].length)) out[cut] = n
    }
  }
  const unique = out.filter((n, k) => out.indexOf(n) === k)
  const read = [...unique.filter(n => OWN_NUMBER_FORM.test(n)), ...unique.filter(n => !OWN_NUMBER_FORM.test(n))]
  return [...read, ...further.filter((n, k) => !read.includes(n) && further.indexOf(n) === k)]
}

/**
 * The owner's invoice number an incoming payment pays, from its bank text: the first of
 * incomeInvoiceNumbers, or null. One strict reader for the booking's title, the duplicate
 * keys, the Mado check and the Drive search: a word („Oktober“), a year („2025“) or a
 * postcode („1070“) is never an invoice number.
 */
export function extractIncomeInvoiceNumber(transaction: BankText): string | null {
  return incomeInvoiceNumbers(transaction)[0] ?? null
}

// Who paid a credit, by name: the paying account's holder as the bank prints it
// (lib/own-transfer.ts), else the counterparty without easybank's place and processor
// (cleanCounterparty). A text that names an invoice number is the transfer's purpose line,
// not a name: lib/csv-parser.ts takes the last part of the text as the counterparty when no
// name follows the IBAN, and findCounterpartyAccount the last line („…|BIC IBAN|RN: …“).
function payerName(tx: BankText & { raw?: Record<string, string> | null }): string {
  const names = [counterpartyAccountOf(tx)?.holder ?? '', cleanCounterparty(tx.counterparty || '')]
  return names.map(n => n.trim()).find(n => n && incomeInvoiceNumbers({ reference: n }).length === 0) ?? ''
}

/**
 * A credit's booking title. With the owner's invoice number: „RN_<Nr> - <Name>“ (at most
 * 50 characters), the name the paying account's holder, else the counterparty
 * (payerName), without a trailing „e.U.“ („Muster Studio e.U“ → „Muster Studio“; a GmbH
 * keeps its „GmbH“); „RN_<Nr>“ alone when no name is known, never „RN_<Nr> - RN: <Nr>“.
 * Without a number: the AI's title, else the name, else the counterparty as given.
 */
export function incomeTitle(
  tx: BankText & { raw?: Record<string, string> | null },
  number: string | null | undefined,
  aiTitle?: string | null,
): string {
  const name = payerName(tx)
  if (!number) return aiTitle || name || cleanCounterparty(tx.counterparty || '')
  const shown = name.replace(/\s+e\.\s*u\.?\s*$/i, '').trim() || name
  return (shown ? `RN_${number} - ${shown}` : `RN_${number}`).slice(0, 50)
}

/**
 * The own invoice a booking title names, as its bare number, so one invoice is
 * recognised however its title was written. Mado books a paid invoice as
 * "RN-202605010 – Beispiel GmbH" (or "RN-202605010 (2026) – …" when the money
 * arrived over two years); Bookmatic books the same bank credit as
 * "RN_202605010 - Beispiel GmbH". Both → "202605010". Null when the text names no
 * RN number, so ordinary expense titles never take part.
 */
export function invoiceKey(text: string | null | undefined): string | null {
  const m = (text || '').match(/(?:^|[^A-Za-z0-9])RN[\s:_\-\/]*(\d{6,})(?!\d)/i)
  return m ? m[1] : null
}

/**
 * The invoice number of an incoming payment as invoiceKey compares it: digits
 * only, at least six, or null. Accepts what extractIncomeInvoiceNumber returns
 * ("202605010", already without its RN- prefix) as well as a full "RN-202605010".
 */
export function incomeInvoiceKey(invoiceNumber: string | null | undefined): string | null {
  if (!invoiceNumber) return null
  const fromTitle = invoiceKey(invoiceNumber)
  if (fromTitle) return fromTitle
  const digits = invoiceNumber.trim()
  return /^\d{6,}$/.test(digits) ? digits : null
}

/** The import's already-booked index entry for an invoice that is booked as a whole. */
export const invoiceIndexKey = (key: string) => `rn|${key}`

/**
 * Mado Invoice writes the owner's invoices from RN-202605008 on (numbers
 * YYYYMMNNN). A payment of one of them is booked by Mado once it is recorded there
 * as paid; Bookmatic must not book it as well, because it cannot stop Mado from
 * booking it again (audit P0-2). Older numbers (RN-202605006 and before) were
 * written before Mado and stay bookable here.
 */
export const MADO_FIRST_INVOICE = 202605008

/**
 * The Mado invoice the first of `texts` names ("RN-202605010", "RN_202605010",
 * "RN: 202605010", or the bare "202605010" that extractIncomeInvoiceNumber returns),
 * or null. Only a nine-digit YYYYMMNNN number with a plausible year and month, at or
 * after MADO_FIRST_INVOICE: a 12-digit vendor reference or a 7-digit "2026/042"
 * never counts.
 */
export function madoInvoiceKey(...texts: (string | null | undefined)[]): string | null {
  for (const t of texts) {
    const key = incomeInvoiceKey(t)
    if (!key || !/^\d{9}$/.test(key)) continue
    const year = Number(key.slice(0, 4)), month = Number(key.slice(4, 6))
    if (year < 2026 || year > 2099 || month < 1 || month > 12) continue
    if (Number(key) >= MADO_FIRST_INVOICE) return key
  }
  return null
}

// A Mado invoice number as clients write it in a transfer: nine digits after an invoice
// word (INVOICE_WORD: RN/RE/RG, „Rechnung“, „Rechnung Nr.“, „Rechnungsnr.“,
// „Rechnungsnummer“, „Re-Nr.“, „Rg.-Nr.“, „Invoice (No.|#)“, „Inv.“). The prefix must start
// a word, so „Ihre 202606014“ doesn't count.
const MADO_PREFIXED = new RegExp(`${WORD_START.source}${INVOICE_WORD.source}${BEFORE_NUMBER.source}(\\d{9})(?!\\d)`, 'gi')

/**
 * The Mado invoice a credit's bank text names, written however the client wrote it
 * (see MADO_PREFIXED), or as the whole purpose of the transfer („202606014“; easybank
 * separates the parts of a bank text with „|“). A number after another word
 * („Auftrag 202607123“, „Kundennr. …“) is not taken: such a credit could not be
 * booked here at all.
 */
export function madoInvoiceInText(text: string | null | undefined): string | null {
  if (!text) return null
  const re = new RegExp(MADO_PREFIXED.source, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const key = madoInvoiceKey(m[1])
    if (key) return key
  }
  for (const part of text.split('|')) {
    const t = part.trim()
    if (/^\d{9}$/.test(t)) {
      const key = madoInvoiceKey(t)
      if (key) return key
    }
  }
  return null
}

/**
 * The Mado invoice a bank credit pays, from everything its bank text says: as clients write
 * it (madoInvoiceInText), else any number the strict reader reads (incomeInvoiceNumbers) —
 * also one in second place cut at easybank's line break („RN 202605006 und RN 2026060|14“)
 * or listed after another („RN 202605006, 202606014“). A credit paying an older invoice and a
 * Mado one is Mado's: never booked here (the older part by hand).
 */
export function madoInvoiceOfCredit(tx: BankText): string | null {
  return madoInvoiceInText([tx.reference, tx.counterparty].filter(Boolean).join('|'))
    ?? incomeInvoiceNumbers(tx).map(n => madoInvoiceKey(n)).find((k): k is string => !!k)
    ?? null
}

/** What a Mado invoice's payment row says instead of being booked here. */
export const MADO_HANDLES_NOTE = 'Mado bucht diese Zahlung — in Mado als bezahlt erfassen'

// A Mado invoice's payment whose bank text names the owner's own invoices too (read strictly,
// none Mado's): their share is no Mado's to book — said on the row first, also once Mado's
// booking holds it (review check INC-1); null when it names none. `heldBy`: the booking that
// holds the row — a certain one of the whole credit (this app's own, the CSV's of the same
// amount, Mado's of all of it) books that share too: nothing to book by hand, or it is
// booked twice (repair check GI-2)
export function madoAlsoPaysNote(
  tx: BankText & { amount?: number | null },
  heldBy?: { total: number; certain: boolean } | null,
): string | null {
  if (heldBy?.certain && tx.amount != null && Math.abs(heldBy.total - Math.abs(tx.amount)) <= 0.02) return null
  const own = incomeInvoiceNumbers(tx).filter(n => !madoInvoiceKey(n))
  return own.length ? `⚠ Zahlt auch ${own.map(n => `RN-${n}`).join(', ')} — diesen Teil selbst in bookamat buchen` : null
}
const isMadoAlsoPaysNote = (part: string) => /^⚠ Zahlt auch RN-/.test(part)

/**
 * The note the page shows on a row it treats as a Mado invoice's payment: madoAlsoPaysNote
 * first, then the row's own note (or `whenNone` when it has none) — computed where the page
 * decides a row is Mado's, so a draft an Analyse before the update saved, a row a Mado PDF
 * attached by hand made Mado's and an older Analyse's row say it too; once, and not under a
 * certain booking of the whole credit (one saved before is taken off). Null: nothing to say
 * (repair check GI-3).
 */
export function madoRowNote(
  t: {
    transaction: BankText & { amount?: number | null }
    match_note?: string | null
    duplicate_of?: { total: number; certain: boolean } | null
  },
  whenNone: string | null = null,
): string | null {
  const parts = (t.match_note || whenNone || '').split(' · ').filter(p => p && !isMadoAlsoPaysNote(p))
  return [madoAlsoPaysNote(t.transaction, t.duplicate_of), ...parts].filter(Boolean).join(' · ') || null
}

/**
 * A receipt was found or attached, but the extractor could not read its data (an
 * answer cut off or not JSON, or an API error). The import's row says so instead of
 * „keine mit Betrag“ or nothing at all; the date and amount shown are not the receipt's.
 */
export const RECEIPT_UNREADABLE_NOTE = '⚠ Beleg-Daten nicht lesbar — Rechnungsdatum und Betrag bitte am Beleg prüfen'

// Clean easybank counterparty names for AI/search:
// "HOFA GMBH\\KARLSDORF-NEU\\76689" → "HOFA GMBH"
// "PADDLE.NET* KLANGIO\\LISBOA\\10" → "KLANGIO"
// "MOL*NUKI HOME SOLUTION\\433162"  → "NUKI HOME SOLUTION"
// "SP IZOTOPE\\BERLIN\\10997"       → "IZOTOPE"
// Moved here from lib/ai-classifier.ts, which re-exports it, so client code can name a row.
export function cleanCounterparty(raw: string): string {
  let name = raw.split('\\')[0].trim()
  if (name.includes('*')) name = name.split('*').slice(1).join('*').trim()
  name = name.replace(/^[A-Z]{2}\s+/, '').trim()
  return name || raw
}

/**
 * An RFC-2822 mail date ("Fri, 17 Jul 2026 07:05:13 +0000") → "2026-07-17".
 *
 * Used as the Rechnungsdatum fallback: a Gmail-matched receipt always carries the
 * email's date, and for an auto-generated receipt that IS effectively the invoice
 * date. The PDF-extracted date always wins; this only fills in when the extractor
 * found none, so the field is pre-filled and editable instead of empty — bookamat
 * requires a Rechnungsdatum for some purchasetax accounts. Returns null rather than
 * inventing a date.
 */
export function emailDateToIso(raw: string | null | undefined): string | null {
  if (!raw) return null
  const d = new Date(raw)
  if (isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}
