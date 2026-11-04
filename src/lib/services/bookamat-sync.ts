// Booking an issued document's money in Bookamat: what a sync would book (read only), and the
// sync itself with the frozen PDF attached. Server only (Bookamat credentials, the PDF renderer).
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { BookamatError, syncBookamatDocument, type BookamatSettings } from '@/lib/bookamat'
import {
  BOOKING_COLUMNS, hasMoneyToBook, planBookings, unbookedPlan,
  type AdoptBooking, type BookingRow, type MoneyRow, type PlannedBooking, type SyncFailure, type SyncSuccess,
} from '@/lib/bookamat-client'
import { isBookamatConfigured } from '@/lib/public-settings'
import { getIssuedPdf } from '@/lib/pdf/snapshot'
import { creditNoteSettled } from '@/lib/status'
import { clientDisplayName } from '@/lib/utils/clients'
import { calcTotals } from '@/lib/utils/document'

// One sync as the sync route runs it: `adopt` records bookings an earlier attempt created but
// could not store (its `pending`), instead of booking them again.
export async function syncBookamat(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  { adopt = [], deadline }: { adopt?: AdoptBooking[]; deadline?: number } = {},
): Promise<SyncSuccess | SyncFailure> {
  return syncBookamatDocument(supabase, settings, documentId, {
    adopt,
    loadPdf: async id => getIssuedPdf(supabase, id, 'on_demand'),
    ...(deadline ? { deadline } : {}),
  })
}

// When Bookamat accepted a booking this database could not record, the second call hands it
// back as `adopt`, so it is recorded instead of booked twice (as the browser's
// requestBookamatSync and the cron do).
export async function syncBookamatWithAdopt(
  supabase: SupabaseClient,
  settings: BookamatSettings,
  documentId: string,
  { deadline }: { deadline?: number } = {},
): Promise<SyncSuccess | SyncFailure> {
  const first = await syncBookamat(supabase, settings, documentId, { deadline })
  if (first.ok || !first.pending?.length) return first
  return syncBookamat(supabase, settings, documentId, { adopt: first.pending, deadline })
}

const PREVIEW_COLS = `id, type, number, status, currency, date, tax_treatment, discount_type, discount_value,
  document_items(line_type, sort_order, quantity, unit_price, vat_rate, discount_type, discount_value),
  payments(date, amount, kind, method), clients(name, company), bookamat_pending, bookamat_bookings(${BOOKING_COLUMNS})`

export type BookamatPreviewDoc = {
  id: string
  type: 'invoice' | 'credit_note'
  number: string
  status: string
  client: string
  total: number
  payments: MoneyRow[]
  recorded: BookingRow[]
  pending: unknown
}

export interface BookamatPreview {
  document: BookamatPreviewDoc
  // What the sync would post, one booking per calendar year; empty when everything is booked.
  bookings: PlannedBooking[]
  // Dunning fees received: reported, never booked.
  fees: number
  // An earlier attempt left bookings whose outcome the sync settles first.
  unsettled: boolean
}

// What syncing the document would book, refused as the sync refuses it (BookamatError). Reads
// only: no claim, no journal, nothing sent to Bookamat.
export async function bookamatPreview(supabase: SupabaseClient, settings: BookamatSettings, documentId: string): Promise<BookamatPreview> {
  if (!isBookamatConfigured(settings)) throw new BookamatError('not_configured', 'Bookamat is not fully configured')
  const { data, error } = await supabase.from('documents').select(PREVIEW_COLS).eq('id', documentId).maybeSingle()
  if (error) throw new BookamatError('database', error.message)
  const doc = data as unknown as (Omit<BookamatPreviewDoc, 'client' | 'total' | 'payments' | 'recorded' | 'pending'> & {
    type: string
    number: string | null
    currency: string | null
    tax_treatment: string | null
    discount_type: string | null
    discount_value: number | null
    document_items: Parameters<typeof calcTotals>[0] | null
    payments: MoneyRow[] | null
    clients: { name: string; company: string | null } | null
    bookamat_pending: unknown
    bookamat_bookings: BookingRow[] | null
  }) | null
  if (!doc) throw new BookamatError('not_found', 'Document not found')
  if ((doc.type !== 'invoice' && doc.type !== 'credit_note') || !doc.number) throw new BookamatError('not_issued', 'Only issued invoices and credit notes can be synced')
  if ((doc.currency ?? 'EUR') !== 'EUR') throw new BookamatError('not_eur', `${doc.number} is not in EUR`, 0, { currency: doc.currency ?? '' })

  const rows = doc.payments ?? []
  const totals = calcTotals(
    doc.document_items ?? [],
    [],
    doc.discount_type && doc.discount_value ? { type: doc.discount_type as 'percent' | 'fixed', value: doc.discount_value } : null,
    doc.tax_treatment,
  )
  if (!totals.vat_groups.length) throw new BookamatError('no_items', 'The document has no lines to book')
  if (doc.type === 'invoice') {
    if (!hasMoneyToBook({ ...doc, type: 'invoice' })) throw new BookamatError('not_settled', 'Only fully paid invoices can be synced')
  } else {
    const { data: applied, error: appliedErr } = await supabase.from('payments').select('amount').eq('kind', 'credit').eq('credit_note_id', doc.id)
    if (appliedErr) throw new BookamatError('database', appliedErr.message)
    const refunded = rows.filter(r => r.kind === 'refund').reduce((s, r) => s + r.amount, 0)
    const settled = creditNoteSettled(totals.total, (applied ?? []).reduce((s, r) => s + Number(r.amount), 0), refunded)
    if (doc.status !== 'sent' || !settled) throw new BookamatError('not_settled', 'Only settled credit notes can be synced')
  }

  const plan = planBookings({ type: doc.type, total: totals.total, rows })
  const recorded = doc.bookamat_bookings ?? []
  const unsettled = Array.isArray(doc.bookamat_pending) && doc.bookamat_pending.length > 0
  if (!plan.bookings.length && !recorded.length && !unsettled) throw new BookamatError('nothing_to_book', 'No money received or paid back on this document')
  return {
    document: {
      id: doc.id,
      type: doc.type,
      number: doc.number,
      status: doc.status,
      client: clientDisplayName(doc.clients),
      total: totals.total,
      payments: rows,
      recorded,
      pending: doc.bookamat_pending ?? null,
    },
    bookings: unbookedPlan(plan.bookings, recorded),
    fees: plan.fees,
    unsettled,
  }
}
