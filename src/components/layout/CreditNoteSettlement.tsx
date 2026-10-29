'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusBadge } from '@/components/lists/StatusBadge'
import { formatDate, formatMoney, roundCents, today } from '@/lib/utils/document'
import { creditNoteOpen, creditNoteSettled, lifecycleErrorMessage, paymentDateIssue } from '@/lib/status'
import { apiErrorMessage, requestErrorMessage } from '@/lib/api-errors'
import {
  BOOKING_COLUMNS, bookamatErrorMessage, bookamatState, formatBookings, planBookings, requestBookamatSync, unbookedPlan, type BookingRow,
} from '@/lib/bookamat-client'
import { logEvent } from '@/lib/events'
import { useT } from '@/lib/i18n/client'
import type { Currency, PaymentMethod } from '@/types'

type Row = { id: string; date: string; amount: number }
type Refund = Row & { method: PaymentMethod; note: string | null; reference: string | null }

interface Props {
  creditNoteId: string
  issued: boolean
  /** The credit note's number once issued (the Bookamat sync needs it). */
  number?: string | null
  total: number
  currency: Currency
  /** The invoice the credit note corrects, with what is still open on it. */
  invoice: { id: string; number: string | null; open: number } | null
  /** 'credit' rows on the invoice that apply this credit note. */
  applied: Row[]
  refunds: Refund[]
  bookamatConfigured?: boolean
}

// How an issued credit note is settled: applied to the open balance of its invoice (automatic on
// issue) and/or paid back to the client. Refunds are money and reduce the VAT report's turnover
// in the period they were paid; once settled, they are booked in Bookamat from here.
export default function CreditNoteSettlement({ creditNoteId, issued, number = null, total, currency, invoice, applied, refunds, bookamatConfigured = false }: Props) {
  const [date, setDate] = useState(today())
  const [dateIssue, setDateIssue] = useState<'required' | 'future' | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [method, setMethod] = useState<PaymentMethod>('bank')
  const [reference, setReference] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmOver, setConfirmOver] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<Refund | null>(null)
  const router = useRouter()
  const supabase = createClient()
  const { t, lang } = useT()

  const appliedSum = roundCents(applied.reduce((s, r) => s + r.amount, 0))
  const refundedSum = roundCents(refunds.reduce((s, r) => s + r.amount, 0))
  const open = creditNoteOpen(total, appliedSum, refundedSum)
  const settled = creditNoteSettled(total, appliedSum, refundedSum)
  const canApply = issued && !applied.length && !!invoice && invoice.open > 0.005 && open > 0.005
  const applyAmount = invoice ? roundCents(Math.min(open, invoice.open)) : 0
  const invoiceLabel = invoice?.number ?? t('common.draft')

  // Bookamat books a credit note's refunds once it is settled (the sync route refuses earlier).
  const [bookamat, setBookamat] = useState<{ error: string | null; bookings: BookingRow[] } | null>(null)
  const [syncing, setSyncing] = useState(false)
  const syncable = issued && !!number && settled && refunds.length > 0 && bookamatConfigured
  useEffect(() => {
    if (!syncable) return
    let current = true
    void createClient()
      .from('documents')
      .select(`bookamat_error, bookamat_bookings(${BOOKING_COLUMNS})`)
      .eq('id', creditNoteId)
      .maybeSingle()
      .then(({ data }) => {
        if (current && data) setBookamat({ error: data.bookamat_error ?? null, bookings: (data.bookamat_bookings ?? []) as BookingRow[] })
      })
    return () => { current = false }
  }, [syncable, creditNoteId, refundedSum])
  const refundRows = refunds.map(r => ({ date: r.date, amount: r.amount, kind: 'refund', method: r.method }))
  const syncState = bookamat && bookamatState({
    type: 'credit_note', number, status: 'sent', bookamat_error: bookamat.error, bookamat_bookings: bookamat.bookings, payments: refundRows,
  })
  const unbooked = bookamat ? unbookedPlan(planBookings({ type: 'credit_note', total, rows: refundRows }).bookings, bookamat.bookings) : []

  async function apply() {
    setSaving(true)
    try {
      const res = await fetch(`/api/credit-notes/${creditNoteId}/apply`, { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { toast.error(apiErrorMessage(t, data, t('messages.api.apply_failed'))); return }
      toast.success(t('lifecycle.credit.applied', { amount: formatMoney(data.applied, currency), number: invoiceLabel }))
      router.refresh()
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      setSaving(false)
    }
  }

  async function syncToBookamat() {
    if (syncing) return
    setSyncing(true)
    try {
      const res = await requestBookamatSync(creditNoteId)
      if (!res.ok) {
        const error = bookamatErrorMessage(t, res.payload)
        toast.error(t('books.sync.failed', { error }))
        setBookamat(b => (b ? { ...b, error } : b))
        return
      }
      const { created, bookings, pdf } = res.data
      setBookamat({ error: null, bookings })
      const made = formatBookings(t, created)
      if (!created.length) toast.info(t('books.sync.alreadySynced', { bookings: formatBookings(t, bookings) }))
      else if (pdf.error) toast.warning(t('books.sync.pdfNotAttached', { bookings: made, error: pdf.error }))
      else toast.success(t(pdf.attached ? 'books.sync.syncedWithPdf' : 'books.sync.syncedToast', { bookings: made }))
      router.refresh()
    } finally {
      setSyncing(false)
    }
  }

  async function addRefund(allowOver = false) {
    const issue = paymentDateIssue(date, today())
    setDateIssue(issue)
    if (issue) { toast.error(t(issue === 'required' ? 'lifecycle.payments.dateRequired' : 'lifecycle.payments.dateFuture')); return }
    const amt = amount ?? 0
    if (amt <= 0) { toast.error(t('payments.invalidAmount')); return }
    if (amt > open + 0.005 && !allowOver) { setConfirmOver(true); return }
    setConfirmOver(false)
    setSaving(true)
    try {
      const row = { date, amount: amt, method, reference: reference.trim() || null, note: note.trim() || null }
      const { error } = await supabase.from('payments').insert({ document_id: creditNoteId, kind: 'refund', ...row })
      if (error) { toast.error(lifecycleErrorMessage(error, t)); return }
      await logEvent(supabase, creditNoteId, 'payment_added', { ...row, kind: 'refund', reference: row.reference ?? undefined })
      toast.success(t('lifecycle.credit.refundRecorded'))
      setAmount(null)
      setReference('')
      setNote('')
      router.refresh()
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      setSaving(false)
    }
  }

  async function removeRefund(refund: Refund) {
    setSaving(true)
    try {
      const { error } = await supabase.rpc('remove_payment', { p_payment_id: refund.id, p_reopen: false })
      if (error) { toast.error(lifecycleErrorMessage(error, t)); return }
      await logEvent(supabase, creditNoteId, 'payment_removed', { amount: refund.amount, date: refund.date, kind: 'refund', method: refund.method })
      setPendingRemove(null)
      router.refresh()
    } catch (err) {
      toast.error(requestErrorMessage(t, err))
    } finally {
      setSaving(false)
    }
  }

  const tag = 'text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 shrink-0'

  return (
    <section aria-labelledby="credit-settlement" className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 id="credit-settlement" className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t('lifecycle.credit.title')}</h2>
        {issued && (settled
          ? <StatusBadge status="settled" label={t('lifecycle.states.settled')} />
          : <span className="text-sm font-semibold text-amber-600">{t('lifecycle.credit.open', { amount: formatMoney(open, currency) })}</span>)}
      </div>

      {!issued ? (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">{t('lifecycle.credit.notIssued')}</p>
      ) : (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {invoice ? t('lifecycle.credit.invoiceHint', { number: invoiceLabel }) : t('lifecycle.credit.standaloneHint')}
        </p>
      )}

      {(applied.length > 0 || refunds.length > 0) && (
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
          {applied.map(r => (
            <div key={r.id} className="flex items-center py-1 sm:py-2 gap-x-3 gap-y-0.5 flex-wrap">
              <span className="text-neutral-500 dark:text-neutral-400 w-24 shrink-0">{formatDate(r.date, lang)}</span>
              <span className="font-medium">{formatMoney(r.amount, currency)}</span>
              {invoice && <Link href={`/invoices/${invoice.id}`} className={`${tag} hover:underline`}>{t('lifecycle.credit.appliedTo', { number: invoiceLabel })}</Link>}
            </div>
          ))}
          {refunds.map(r => (
            <div key={r.id} className="flex items-center py-1 sm:py-2 gap-x-3 gap-y-0.5 flex-wrap">
              <span className="text-neutral-500 dark:text-neutral-400 w-24 shrink-0">{formatDate(r.date, lang)}</span>
              <span className="font-medium">{formatMoney(r.amount, currency)}</span>
              <span className={tag}>{t('lifecycle.credit.refund')}</span>
              {r.method === 'cash' && <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 shrink-0">{t('payments.cashBadge')}</span>}
              {r.reference && <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono truncate min-w-0">{t('lifecycle.payments.referenceShort', { reference: r.reference })}</span>}
              {r.note && <span className="text-neutral-500 dark:text-neutral-400 flex-1 truncate min-w-0">{r.note}</span>}
              <button
                type="button"
                onClick={() => setPendingRemove(r)}
                aria-label={t('lifecycle.credit.removeRefund', { amount: formatMoney(r.amount, currency), date: formatDate(r.date, lang) })}
                className="ml-auto h-11 w-11 -mr-2 sm:h-8 sm:w-8 sm:-mr-1 shrink-0 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {syncable && bookamat && syncState && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
          {syncState === 'synced' && bookamat.bookings.length > 0 && (
            <span className="text-neutral-500 dark:text-neutral-400">{t('books.sync.synced', { bookings: formatBookings(t, bookamat.bookings) })}</span>
          )}
          {syncState === 'failed' && bookamat.error && (
            <span role="alert" className="text-red-600 dark:text-red-400 min-w-0 break-words">{t('books.sync.lastError', { error: bookamat.error })}</span>
          )}
          {(syncState !== 'synced' || unbooked.length > 0) && (
            <button
              type="button"
              onClick={() => void syncToBookamat()}
              disabled={syncing}
              className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-8 px-2.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50 text-neutral-600 dark:text-neutral-300"
            >
              <RefreshCw size={12} className={syncing ? 'animate-spin' : undefined} aria-hidden="true" />
              {syncing ? t('messages.creditBookamat.syncing')
                : syncState === 'synced' ? t('messages.creditBookamat.syncNew')
                : syncState === 'failed' ? t('books.sync.retry')
                : t('messages.creditBookamat.sync')}
            </button>
          )}
          {syncState === 'unsynced' && <span className="text-neutral-500 dark:text-neutral-400">{t('messages.creditBookamat.hint')}</span>}
        </div>
      )}

      {canApply && (
        <button
          type="button"
          onClick={() => void apply()}
          disabled={saving}
          className="text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50 text-neutral-600 dark:text-neutral-300"
        >
          {saving ? t('lifecycle.credit.applying') : t('lifecycle.credit.applyTo', { amount: formatMoney(applyAmount, currency), number: invoiceLabel })}
        </button>
      )}

      {issued && !settled && (
        <div className="space-y-2 pt-1">
          <div className="flex gap-2">
            <Input
              type="date"
              required
              max={today()}
              aria-label={t('lifecycle.credit.refundDate')}
              aria-invalid={dateIssue ? true : undefined}
              value={date}
              onChange={e => { setDate(e.target.value); setDateIssue(null) }}
              className="flex-1 min-w-0"
            />
            <MoneyInput
              aria-label={t('lifecycle.credit.refundAmount', { currency })}
              placeholder={t('lifecycle.credit.refundAmount', { currency })}
              value={amount}
              onValueChange={setAmount}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex gap-2">
            <select
              aria-label={t('payments.paymentMethod')}
              value={method}
              onChange={e => setMethod(e.target.value as PaymentMethod)}
              className="shrink-0 h-8 text-base md:text-sm border border-neutral-200 dark:border-neutral-700 rounded-md px-2 bg-white dark:bg-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-1 focus:ring-neutral-400"
            >
              <option value="bank">{t('payments.methodBank')}</option>
              <option value="cash">{t('payments.methodCash')}</option>
            </select>
            <Input
              aria-label={t('lifecycle.payments.reference')}
              placeholder={t('lifecycle.payments.reference')}
              value={reference}
              maxLength={140}
              onChange={e => setReference(e.target.value)}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex gap-2">
            <Input
              aria-label={t('payments.note')}
              placeholder={t('payments.note')}
              value={note}
              onChange={e => setNote(e.target.value)}
              className="flex-1 min-w-0"
            />
            <Button type="button" onClick={() => void addRefund()} disabled={saving} size="sm" className="shrink-0 flex items-center gap-1.5 h-8">
              <Plus size={13} />
              {saving ? t('common.saving') : t('lifecycle.credit.recordRefund')}
            </Button>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmOver}
        title={t('lifecycle.credit.overRefundTitle')}
        description={t('lifecycle.credit.overRefundDesc', { amount: formatMoney(amount ?? 0, currency), open: formatMoney(open, currency) })}
        confirmLabel={t('payments.recordAnyway')}
        busy={saving}
        onConfirm={() => void addRefund(true)}
        onCancel={() => setConfirmOver(false)}
      />

      <ConfirmDialog
        open={!!pendingRemove}
        title={t('lifecycle.credit.removeRefundTitle')}
        description={pendingRemove ? t('lifecycle.credit.removeRefundDesc', { amount: formatMoney(pendingRemove.amount, currency), date: formatDate(pendingRemove.date, lang) }) : undefined}
        confirmLabel={saving ? t('common.removing') : t('common.remove')}
        destructive
        busy={saving}
        onConfirm={() => { if (pendingRemove) void removeRefund(pendingRemove) }}
        onCancel={() => setPendingRemove(null)}
      />
    </section>
  )
}
