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

// "2026-001" must not match "2026-0012": the normalised number may not touch another digit.
const numberPattern = (number: string) => new RegExp(`(?<!\\d)${number.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`)

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

export function matchTransactions(transactions: BankTransaction[], invoices: OpenInvoice[], importedRefs: Set<string>): MatchRow[] {
  const open = invoices.filter(i => i.balance > 0.005)
  // Running balance: an invoice can absorb several credits only while something is still open.
  const remaining = new Map(open.map(i => [i.id, i.balance]))
  const clientTokens = new Map(open.map(i => [i.id, nameTokens(`${i.clientName} ${i.clientCompany ?? ''}`)]))
  // Numbers under three characters ("R1") would turn up everywhere; those count on amount and name only.
  const numberPatterns = new Map(open.map(i => {
    const number = alnum(i.number)
    return [i.id, number.length >= 3 ? numberPattern(number) : null]
  }))
  const rows: MatchRow[] = []

  for (const tx of transactions) {
    const base: Omit<MatchRow, 'status'> = { transaction: tx, invoiceId: null, confidence: null, score: 0, reasons: [], skontoAmount: 0, amountToRecord: tx.amount }
    if (importedRefs.has(tx.id)) { rows.push({ ...base, status: 'imported' }); continue }
    if (tx.amount <= 0) { rows.push({ ...base, status: 'debit' }); continue }
    if (!open.length) { rows.push({ ...base, status: 'nothing_open' }); continue }

    const haystack = `${alnum(tx.text)}|${alnum(tx.reference ?? '')}`
    const counterparty = nameTokens(tx.counterparty)
    let best: { inv: OpenInvoice; score: number; reasons: MatchReason[]; skonto: number } | null = null

    for (const inv of open) {
      const balance = remaining.get(inv.id)!
      if (balance <= 0.005) continue
      const paid = roundCents(inv.total - balance)
      let score = 0
      let skonto = 0
      const reasons: MatchReason[] = []

      const pattern = numberPatterns.get(inv.id)
      if (pattern && pattern.test(haystack)) { score += 100; reasons.push('number') }

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
