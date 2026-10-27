import { parseLocaleNumber, roundCents } from '../utils/number'
import type { BankTransaction, CsvMapping, ParsedStatement } from './types'

// Structural subset of the DOM so the CAMT parser also runs under node with a tiny stub.
export interface XmlElement {
  localName: string
  children: ArrayLike<XmlElement>
  textContent: string | null
  getAttribute(name: string): string | null
}
export interface XmlDocument {
  documentElement: XmlElement | null
}

export type TransactionFields = Pick<BankTransaction, 'date' | 'amount' | 'text' | 'counterparty' | 'reference'>

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()

// FNV-1a and djb2 (32 bit each) over the normalised fields: stable across imports, no crypto needed.
export function transactionId(f: TransactionFields): string {
  const key = [
    f.date,
    f.amount.toFixed(2),
    collapse(f.text).toLowerCase(),
    collapse(f.counterparty ?? '').toLowerCase(),
    collapse(f.reference ?? '').toLowerCase(),
  ].join('|')
  let fnv = 0x811c9dc5
  let djb = 5381
  for (let i = 0; i < key.length; i++) {
    const c = key.charCodeAt(i)
    fnv = Math.imul(fnv ^ c, 0x01000193)
    djb = (Math.imul(djb, 33) + c) | 0
  }
  return (fnv >>> 0).toString(16).padStart(8, '0') + (djb >>> 0).toString(16).padStart(8, '0')
}

// Two identical bookings on one day hash alike; the second one gets a suffix so both can be imported.
function dedupeIds(transactions: BankTransaction[]) {
  const seen = new Map<string, number>()
  for (const t of transactions) {
    const n = (seen.get(t.id) ?? 0) + 1
    seen.set(t.id, n)
    if (n > 1) t.id = `${t.id}-${n}`
  }
}

export function parseDate(raw: string): string | null {
  const s = raw.trim()
  let y: number, m: number, d: number
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s]|$)/)
  const dotted = iso ? null : s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(?:\s|$)/)
  const slashed = iso || dotted ? null : s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s|$)/)
  if (iso) { y = +iso[1]; m = +iso[2]; d = +iso[3] }
  else if (dotted) { d = +dotted[1]; m = +dotted[2]; y = +dotted[3] }
  else if (slashed) { d = +slashed[1]; m = +slashed[2]; y = +slashed[3] }
  else return null
  if (y < 100) y += 2000
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  if (new Date(Date.UTC(y, m - 1, d)).getUTCMonth() !== m - 1) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

// "1.234,56", "1,234.56", "-12,00", "12,00-", "(12.00)", "12.00 DR", "EUR 12,00"
export function parseAmount(raw: string): number | null {
  let s = raw.trim()
  if (!s) return null
  let negative = false
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1) }
  if (/\bDR\b/i.test(s)) negative = true
  s = s.replace(/\b(CR|DR)\b/gi, '').replace(/[A-Za-z€$£\s]/g, '')
  if (s.endsWith('-')) { negative = true; s = s.slice(0, -1) }
  if (s.endsWith('+')) s = s.slice(0, -1)
  if (s.startsWith('-')) { negative = true; s = s.slice(1) }
  if (s.startsWith('+')) s = s.slice(1)
  const n = parseLocaleNumber(s)
  if (n === null) return null
  return negative ? -Math.abs(n) : n
}

// ─── CAMT.053 / 052 / 054 ────────────────────────────────────────────────────

function kids(el: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = []
  const c = el.children
  for (let i = 0; i < c.length; i++) if (c[i].localName === name) out.push(c[i])
  return out
}

function kid(el: XmlElement | null, ...path: string[]): XmlElement | null {
  let cur = el
  for (const name of path) {
    if (!cur) return null
    cur = kids(cur, name)[0] ?? null
  }
  return cur
}

function descendants(el: XmlElement, name: string, out: XmlElement[] = []): XmlElement[] {
  const c = el.children
  for (let i = 0; i < c.length; i++) {
    if (c[i].localName === name) out.push(c[i])
    descendants(c[i], name, out)
  }
  return out
}

const textOf = (el: XmlElement | null) => (el ? collapse(el.textContent ?? '') : '')

export function parseCamt(doc: XmlDocument): ParsedStatement {
  const warnings: string[] = []
  const transactions: BankTransaction[] = []
  const root = doc.documentElement
  if (!root || root.localName === 'parsererror' || descendants(root, 'parsererror').length) {
    return { format: 'camt', transactions, warnings: ['xml'] }
  }

  descendants(root, 'Ntry').forEach((ntry, i) => {
    const n = i + 1
    const amtEl = kid(ntry, 'Amt')
    const amtRaw = Number(textOf(amtEl))
    const credit = textOf(kid(ntry, 'CdtDbtInd')).toUpperCase() !== 'DBIT'
    const date = parseDate(
      textOf(kid(ntry, 'BookgDt', 'Dt')) || textOf(kid(ntry, 'BookgDt', 'DtTm')) ||
      textOf(kid(ntry, 'ValDt', 'Dt')) || textOf(kid(ntry, 'ValDt', 'DtTm'))
    )
    if (textOf(kid(ntry, 'RvslInd')).toLowerCase() === 'true') {
      warnings.push(`reversal:${date ?? '?'} ${credit ? '' : '-'}${textOf(amtEl)} ${amtEl?.getAttribute('Ccy') ?? ''}`.trim())
      return
    }
    if (!date) { warnings.push(`noDate:${n}`); return }
    if (!textOf(amtEl) || !Number.isFinite(amtRaw)) { warnings.push(`noAmount:${n}`); return }
    const amount = roundCents(credit ? amtRaw : -amtRaw)
    const currency = amtEl?.getAttribute('Ccy') || null

    const ustrd = descendants(ntry, 'Ustrd').map(textOf).filter(Boolean)
    const addtlTx = descendants(ntry, 'AddtlTxInf').map(textOf).filter(Boolean)
    const addtlNtry = textOf(kid(ntry, 'AddtlNtryInf'))
    const parts = ustrd.length ? ustrd : addtlTx.length ? addtlTx : addtlNtry ? [addtlNtry] : []
    const text = collapse(parts.join(' '))

    const strdRef = descendants(ntry, 'CdtrRefInf').map(e => textOf(kid(e, 'Ref'))).find(Boolean) ?? null
    const endToEnd = descendants(ntry, 'EndToEndId').map(textOf).find(r => r && r.toUpperCase() !== 'NOTPROVIDED') ?? null
    const reference = strdRef || endToEnd || null

    let counterparty: string | null = null
    const parties = credit ? ['Dbtr', 'UltmtDbtr'] : ['Cdtr', 'UltmtCdtr']
    for (const rltd of descendants(ntry, 'RltdPties')) {
      for (const p of parties) {
        const party = kid(rltd, p)
        const name = party ? textOf(descendants(party, 'Nm')[0] ?? null) : ''
        if (name) { counterparty = name; break }
      }
      if (counterparty) break
    }

    const fields: TransactionFields = { date, amount, text, counterparty, reference }
    transactions.push({ id: transactionId(fields), ...fields, currency, raw: collapse(ntry.textContent ?? '').slice(0, 2000) })
  })

  dedupeIds(transactions)
  if (!transactions.length && !warnings.length) warnings.push('noEntries')
  return { format: 'camt', transactions, warnings }
}

// ─── CSV ─────────────────────────────────────────────────────────────────────

// RFC 4180: quoted cells, doubled quotes, newlines inside quotes; CRLF, LF or CR line ends.
export function splitCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"' && cell === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(cell); cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell); rows.push(row); row = []; cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

// The delimiter that yields the most lines of one width across the first 20 lines; ties go to
// the wider table (an amount's decimal comma splits every line into exactly two cells).
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim()).slice(0, 20)
  let best = ';'
  let bestScore = -1
  let bestWidth = 0
  for (const d of [';', ',', '\t']) {
    const widths = lines.map(l => splitCsv(l, d)[0]?.length ?? 1).filter(w => w >= 2)
    const counts = new Map<number, number>()
    for (const w of widths) counts.set(w, (counts.get(w) ?? 0) + 1)
    let mode = 0
    let modeCount = 0
    for (const [w, c] of counts) if (c > modeCount || (c === modeCount && w > mode)) { mode = w; modeCount = c }
    if (modeCount > bestScore || (modeCount === bestScore && mode > bestWidth)) { best = d; bestScore = modeCount; bestWidth = mode }
  }
  return best
}

const SYNONYMS = {
  date: ['buchungsdatum', 'valutadatum', 'valuta', 'datum', 'date', 'booking date', 'value date', 'transaction date'],
  amount: ['betrag', 'amount', 'umsatz', 'value'],
  credit: ['haben', 'credit', 'gutschrift'],
  debit: ['soll', 'debit', 'lastschrift'],
  text: ['verwendungszweck', 'buchungstext', 'zahlungsreferenz', 'zahlungsgrund', 'umsatztext', 'description', 'details', 'reference', 'text', 'purpose', 'memo', 'narrative', 'remittance'],
  counterparty: ['auftraggeber', 'empfänger', 'empfaenger', 'name', 'partnername', 'partner', 'zahlungspflichtiger', 'counterparty', 'payer', 'payee', 'beneficiary', 'sender', 'recipient'],
  currency: ['währung', 'waehrung', 'currency', 'ccy'],
}

const normHeader = (s: string) =>
  s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').replace(/[^a-z0-9]/g, '')

// Exact synonym first, then the shortest header containing one ("Amount (EUR)" over "Amount (Foreign Currency)").
function pickColumn(names: string[], synonyms: string[], taken: Set<number>, skip?: (name: string) => boolean): number | null {
  const free = (i: number) => !taken.has(i) && !(skip && skip(names[i]))
  for (const syn of synonyms.map(normHeader)) {
    const exact = names.findIndex((n, i) => n === syn && free(i))
    if (exact >= 0) return exact
  }
  for (const syn of synonyms.map(normHeader)) {
    let best: number | null = null
    for (let i = 0; i < names.length; i++) {
      if (!free(i) || !names[i].includes(syn)) continue
      if (best === null || names[i].length < names[best].length) best = i
    }
    if (best !== null) return best
  }
  return null
}

export function emptyMapping(): CsvMapping {
  return { date: null, amount: null, credit: null, debit: null, text: [], counterparty: null, currency: null }
}

export function guessMapping(header: string[]): CsvMapping {
  const names = header.map(normHeader)
  const taken = new Set<number>()
  const isAccount = (n: string) => n.includes('iban') || n.includes('bic')
  const take = (idx: number | null) => { if (idx !== null) taken.add(idx); return idx }

  const mapping = emptyMapping()
  mapping.date = take(pickColumn(names, SYNONYMS.date, taken))
  mapping.amount = take(pickColumn(names, SYNONYMS.amount, taken, n => n.includes('date') || n.includes('datum')))
  if (mapping.amount === null) {
    mapping.credit = take(pickColumn(names, SYNONYMS.credit, taken))
    mapping.debit = take(pickColumn(names, SYNONYMS.debit, taken))
  }
  mapping.currency = take(pickColumn(names, SYNONYMS.currency, taken, n => n.includes('foreign') || n.includes('original') || n.includes('fremd')))
  mapping.counterparty = take(pickColumn(names, SYNONYMS.counterparty, taken, isAccount))
  const textSyn = SYNONYMS.text.map(normHeader)
  names.forEach((n, i) => {
    if (!taken.has(i) && !isAccount(n) && textSyn.some(s => n.includes(s))) { mapping.text.push(i); taken.add(i) }
  })
  return mapping
}

// A date column and an amount (or credit / debit) column are the least a mapping needs.
const isMapped = (m: CsvMapping) => m.date !== null && (m.amount !== null || m.credit !== null || m.debit !== null)

export function applyMapping(rows: string[][], mapping: CsvMapping): { transactions: BankTransaction[]; warnings: string[] } {
  const transactions: BankTransaction[] = []
  const warnings: string[] = []
  if (!isMapped(mapping)) return { transactions, warnings: ['unmapped'] }
  rows.forEach((row, i) => {
    const n = i + 1
    const cell = (idx: number | null) => (idx === null ? '' : (row[idx] ?? '')).trim()
    const date = parseDate(cell(mapping.date))
    if (!date) { warnings.push(`noDate:${n}`); return }
    let amount: number | null
    if (mapping.amount !== null) {
      amount = parseAmount(cell(mapping.amount))
    } else {
      const c = parseAmount(cell(mapping.credit))
      const d = parseAmount(cell(mapping.debit))
      // A credit printed negative ("12,00-" in Haben) is a reversed credit, i.e. money going out.
      amount = c === null && d === null ? null : c !== null && c < 0 ? c : Math.abs(c ?? 0) - Math.abs(d ?? 0)
    }
    if (amount === null) { warnings.push(`noAmount:${n}`); return }
    const fields: TransactionFields = {
      date,
      amount: roundCents(amount),
      text: collapse(mapping.text.map(cell).filter(Boolean).join(' ')),
      counterparty: cell(mapping.counterparty) || null,
      reference: null,
    }
    transactions.push({ id: transactionId(fields), ...fields, currency: cell(mapping.currency).toUpperCase() || null, raw: row.join(' ; ') })
  })
  dedupeIds(transactions)
  if (!transactions.length && !warnings.length) warnings.push('noEntries')
  return { transactions, warnings }
}

const filled = (row: string[]) => row.filter(c => c !== '').length
const SAMPLE_ROWS = 10

// The rows after a header, cut or padded to its width.
function tableRows(all: string[][], headerIdx: number, limit?: number): string[][] {
  const width = all[headerIdx].length
  return all.slice(headerIdx + 1, limit === undefined ? undefined : headerIdx + 1 + limit).map(r => {
    const row = r.slice(0, width)
    while (row.length < width) row.push('')
    return row
  })
}

// Bank exports open with account lines ("Konto;AT61…;EUR" / "Inhaber;Max;EUR") that look like a
// narrow table of their own. Among the lines with at least three filled cells, the header is the
// one whose following rows parse best as date + amount under the guessed mapping. When no candidate
// parses a row (a statement without bookings), the one whose guessed mapping has a date and an
// amount column at all wins; then the candidate followed by the longest run of rows of its width,
// then the earlier line.
function findHeader(all: string[][]): number {
  let best = { idx: -1, score: -1, mapped: false, run: -1 }
  for (let i = 0; i < all.length; i++) {
    if (filled(all[i]) < 3) continue
    const mapping = guessMapping(all[i])
    const mapped = isMapped(mapping)
    const score = applyMapping(tableRows(all, i, SAMPLE_ROWS), mapping).transactions.length
    let run = 0
    while (i + 1 + run < all.length && all[i + 1 + run].length === all[i].length) run++
    const better = score !== best.score ? score > best.score : mapped !== best.mapped ? mapped : run > best.run
    if (better) best = { idx: i, score, mapped, run }
  }
  return best.idx
}

export function parseCsv(text: string): ParsedStatement {
  const delimiter = detectDelimiter(text)
  const all = splitCsv(text, delimiter).map(r => r.map(c => c.trim())).filter(r => filled(r) > 0)

  const headerIdx = findHeader(all)
  if (headerIdx < 0) return { format: 'csv', transactions: [], warnings: ['noHeader'], csv: { header: [], rows: [], mapping: emptyMapping() } }

  const header = all[headerIdx]
  const rows = tableRows(all, headerIdx)
  const mapping = guessMapping(header)
  const { transactions, warnings } = applyMapping(rows, mapping)
  return { format: 'csv', transactions, warnings, csv: { header, rows, mapping } }
}

// ─── Entry points ────────────────────────────────────────────────────────────

// UTF-8 (BOM stripped by TextDecoder); a replacement character means the export is windows-1252.
export function decodeStatement(bytes: ArrayBuffer): string {
  const utf8 = new TextDecoder('utf-8').decode(bytes)
  if (!utf8.includes('�')) return utf8
  try { return new TextDecoder('windows-1252').decode(bytes) } catch { return utf8 }
}

export function isCamt(text: string): boolean {
  const head = text.replace(/^﻿/, '').trimStart()
  return head.startsWith('<') && /Document|BkToCstmrStmt|Ntfctn|Rpt/.test(head.slice(0, 5000))
}

export function parseStatement(text: string, opts: { xmlParser: (xml: string) => XmlDocument }): ParsedStatement {
  const src = text.replace(/^﻿/, '')
  return isCamt(src) ? parseCamt(opts.xmlParser(src)) : parseCsv(src)
}
