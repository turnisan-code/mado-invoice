// Document lifecycle: the allowed status changes per document type and the states derived from
// payments and dates. supabase/migrations/20261030_lifecycle.sql (documents_status_guard)
// enforces the same table in the database, so a step missing here is rejected there too.
import type { DisplayStatus, DocumentStatus, DocumentType, PaymentKind, PaymentState } from '@/types'
import type { DictKey, TFn } from '@/lib/i18n'
import { numberingErrorMessage } from '@/lib/utils/numbering'
import { settlesBalance } from '@/lib/utils/document'

export const DOCUMENT_STATUSES: Record<DocumentType, readonly DocumentStatus[]> = {
  invoice: ['draft', 'sent', 'overdue', 'paid', 'cancelled'],
  quote: ['draft', 'sent', 'accepted', 'rejected', 'cancelled'],
  credit_note: ['draft', 'sent', 'cancelled'],
}

// Cancelled is terminal everywhere. Leaving draft means issuing (number assigned in the same
// step). An issued invoice is cancelled only with its Storno and an issued credit note never.
const TRANSITIONS: Record<DocumentType, Partial<Record<DocumentStatus, readonly DocumentStatus[]>>> = {
  invoice: {
    draft: ['sent', 'cancelled'],
    sent: ['overdue', 'paid', 'cancelled'],
    overdue: ['sent', 'paid', 'cancelled'],
    paid: ['sent', 'overdue', 'cancelled'],
  },
  quote: {
    draft: ['sent', 'cancelled'],
    sent: ['accepted', 'rejected', 'cancelled'],
    accepted: ['rejected', 'cancelled'],
    rejected: ['accepted', 'cancelled'],
  },
  credit_note: {
    draft: ['sent', 'cancelled'],
  },
}

export function canTransition(type: DocumentType, from: DocumentStatus, to: DocumentStatus): boolean {
  return TRANSITIONS[type][from]?.includes(to) ?? false
}

// paid → sent/overdue happens only when a payment is removed (remove_payment), never by choice.
export function isReopen(type: DocumentType, from: DocumentStatus, to: DocumentStatus): boolean {
  return type === 'invoice' && from === 'paid' && (to === 'sent' || to === 'overdue')
}

// The statuses the status menu offers. From draft an invoice can also go straight to paid: it is
// issued first and the payment recorded after, both allowed steps.
export function statusMenuTargets(doc: { type: DocumentType; status: DocumentStatus }): DocumentStatus[] {
  const targets = DOCUMENT_STATUSES[doc.type].filter(s => canTransition(doc.type, doc.status, s) && !isReopen(doc.type, doc.status, s))
  if (doc.type === 'invoice' && doc.status === 'draft') targets.splice(1, 0, 'paid')
  return targets
}

// Quotes keep their validity date in due_date.
export function isExpired(doc: { type: string; status: string; due_date: string | null }, today: string): boolean {
  return doc.type === 'quote' && doc.status === 'sent' && !!doc.due_date && doc.due_date < today
}

// The cron marks past-due invoices 'overdue' once a day; until then a 'sent' one past its due
// date already is.
export function isOverdue(doc: { status: string; due_date: string | null }, today: string): boolean {
  return doc.status === 'overdue' || (doc.status === 'sent' && !!doc.due_date && doc.due_date < today)
}

export function canRemind(doc: { type: string; number: string | null; status: string; due_date: string | null }, balance: number, today: string): boolean {
  return doc.type === 'invoice' && !!doc.number && isOverdue(doc, today) && balance > 0.005
}

// A leftover under one euro written off is a rounding or bank-fee difference; more is a real
// write-off of an uncollectible amount.
export const SMALL_DIFFERENCE = 1

// Payments and refunds happened on a real calendar day, never in the future.
export function paymentDateIssue(date: string, today: string): 'required' | 'future' | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return 'required'
  return date > today ? 'future' : null
}

type PaymentRow = { amount: number; kind?: PaymentKind | string | null }

const sum = (rows: PaymentRow[]) => Math.round(rows.reduce((s, p) => s + p.amount, 0) * 100) / 100

// Every kind but 'fee' closes the balance (money, Skonto, write-off, an applied credit note);
// dunning fees paid on top never count as paying or overpaying the invoice.
export function paymentState(total: number, payments: PaymentRow[]): PaymentState {
  if (total <= 0.005) return 'nothing_due'
  payments = payments.filter(settlesBalance)
  const settled = sum(payments)
  const balance = Math.round((total - settled) * 100) / 100
  if (settled <= 0.005) return 'unpaid'
  if (balance > 0.005) return 'partially_paid'
  if (balance < -0.005) return 'overpaid'
  return sum(payments.filter(p => p.kind === 'writeoff')) >= SMALL_DIFFERENCE ? 'written_off' : 'paid'
}

// An issued credit note is settled once what it credits has been applied to its invoice or
// paid back to the client.
export function creditNoteSettled(total: number, applied: number, refunded: number): boolean {
  return total > 0.005 && applied + refunded >= total - 0.005
}

export function creditNoteOpen(total: number, applied: number, refunded: number): number {
  return Math.max(0, Math.round((total - applied - refunded) * 100) / 100)
}

type DisplayInput = {
  type: string
  status: string
  due_date?: string | null
  total?: number
  payments?: PaymentRow[]
  // Credit notes: applied to the invoice + refunded.
  creditSettled?: boolean
}

// The badge shows the stored status unless payments or dates say more: an invoice partly paid
// or written off, a credit note settled, a quote expired. Nothing derived is ever stored.
export function displayStatus(doc: DisplayInput, today: string): DisplayStatus {
  const status = doc.status as DocumentStatus
  if (doc.type === 'quote') return isExpired({ type: doc.type, status, due_date: doc.due_date ?? null }, today) ? 'expired' : status
  if (doc.type === 'credit_note') return status === 'sent' && doc.creditSettled ? 'settled' : status
  if (doc.type !== 'invoice' || doc.total === undefined || !doc.payments) return status
  const state = paymentState(doc.total, doc.payments)
  if (status === 'sent' && state === 'partially_paid') return 'partially_paid'
  if (status === 'paid' && state === 'written_off') return 'written_off'
  return status
}

const DERIVED: Record<string, DictKey> = {
  partially_paid: 'lifecycle.states.partially_paid',
  written_off: 'lifecycle.states.written_off',
  settled: 'lifecycle.states.settled',
}

export function statusLabelKey(status: DisplayStatus | string): DictKey {
  return DERIVED[status] ?? (`status.${status}` as DictKey)
}

type DbError = { code?: string | null; message: string; details?: string | null }

// The lifecycle trigger and RPCs raise English messages with MI010–MI018, the deposit guards MI019–MI022; numbering (MI001–MI003)
// and issue_document's MI004 (incomplete, every reason in the detail) are worded by
// numberingErrorMessage, which also covers anything else without the raw text.
export function lifecycleErrorMessage(error: DbError, t: TFn): string {
  switch (error.code) {
    case 'MI010': return t('lifecycle.errors.transition')
    case 'MI011': return t('lifecycle.errors.issueFirst')
    case 'MI012': return t('lifecycle.errors.needsStorno')
    case 'MI013': return t('lifecycle.errors.creditNoteFinal')
    case 'MI014': return t('lifecycle.errors.reopenByPayment')
    case 'MI015': return t('lifecycle.errors.issuedNoDelete')
    case 'MI016': return t('lifecycle.errors.quoteNotConvertible')
    case 'MI017': return t('lifecycle.errors.alreadyCancelled')
    case 'MI018': return t('lifecycle.errors.draftNoStorno')
    case 'MI019': return t('deposits.errors.useFinal')
    case 'MI020': return t('deposits.errors.deducted')
    case 'MI021': return t('deposits.errors.invalidLink')
    case 'MI022': return t('records.deposits.moneyLocked')
    default: return numberingErrorMessage(error, t)
  }
}

// A thrown error from issueDocument or a route carries the database code along.
export function asDbError(err: unknown): DbError {
  if (err && typeof err === 'object' && 'message' in err) {
    const e = err as { code?: unknown; message: unknown; details?: unknown }
    return {
      code: typeof e.code === 'string' ? e.code : null,
      message: String(e.message),
      details: typeof e.details === 'string' ? e.details : null,
    }
  }
  return { message: String(err) }
}
