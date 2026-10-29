'use client'

import { useEffect, useId, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { formatDate, formatMoney, today, roundCents, settlesBalance, skontoAmount, skontoDeadline } from '@/lib/utils/document'
import { Trash2, Plus, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { Select } from '@/components/ui/select'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { StatusBadge } from '@/components/lists/StatusBadge'
import type { BookamatPending, Currency, PaymentKind, PaymentMethod } from '@/types'
import { useT } from '@/lib/i18n/client'
import { n } from '@/lib/i18n'
import { logEvent } from '@/lib/events'
import { canTransition, DOCUMENT_STATUSES, paymentDateIssue, paymentState, SMALL_DIFFERENCE } from '@/lib/status'
import { dbErrorMessage } from '@/lib/api-errors'
import { BOOKING_COLUMNS, bookamatErrorMessage, formatBookings, hasMoneyToBook, planBookings, requestBookamatSync, unbookedPlan, type BookingRow } from '@/lib/bookamat-client'
import { loadMoneyLock } from '@/lib/deposits'

interface Payment {
  id: string
  date: string
  amount: number
  note: string | null
  kind: PaymentKind
  method: PaymentMethod
  reference?: string | null
  credit_note_id?: string | null
}

type NewPayment = Omit<Payment, 'id' | 'credit_note_id'>

// Statuses a settled invoice moves to 'paid' from.
const PAYABLE: readonly string[] = DOCUMENT_STATUSES.invoice.filter(s => canTransition('invoice', s, 'paid'))

// `pending`: bookings a sync posted but could not record or confirm; the next sync settles them.
type BookamatInfo = { bookings: BookingRow[]; error: string | null; pending: BookamatPending[] }

async function fetchBookamatInfo(documentId: string): Promise<BookamatInfo | null> {
  const { data, error } = await createClient()
    .from('documents')
    .select(`bookamat_error, bookamat_pending, bookamat_bookings(${BOOKING_COLUMNS})`)
    .eq('id', documentId)
    .maybeSingle()
  if (error || !data) return null
  return {
    bookings: ((data.bookamat_bookings ?? []) as BookingRow[]).sort((a, b) => a.year - b.year),
    error: data.bookamat_error ?? null,
    pending: Array.isArray(data.bookamat_pending) ? data.bookamat_pending as BookamatPending[] : [],
  }
}

const settledSum = (rows: { amount: number; kind?: string | null }[]) => roundCents(rows.filter(settlesBalance).reduce((s, p) => s + p.amount, 0))

interface Props {
  documentId: string
  number: string | null
  status: string
  date: string
  total: number
  payments: Payment[]
  currency: Currency
  skontoPercent?: number | null
  skontoDays?: number | null
  bookamatConfigured?: boolean
  // Legacy single booking id; shown until the bookings are loaded.
  bookamatBookingId?: string | null
}

export default function PaymentPanel({
  documentId, number, status, date, total, payments: initial, currency, skontoPercent, skontoDays,
  bookamatConfigured, bookamatBookingId,
}: Props) {
  const [payments, setPayments] = useState<Payment[]>(initial)
  // Payments can also be added elsewhere on the page (status pill → paid); follow server refreshes.
  const [seenInitial, setSeenInitial] = useState(initial)
  if (initial !== seenInitial) {
    setSeenInitial(initial)
    setPayments(initial)
  }
  const [payDate, setPayDate] = useState(today())
  const [dateIssue, setDateIssue] = useState<'required' | 'future' | null>(null)
  const [amount, setAmount] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [reference, setReference] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('bank')
  const [saving, setSaving] = useState(false)
  const [overpay, setOverpay] = useState<{ amount: number; choice: 'fee' | 'payment' } | null>(null)
  const [writingOff, setWritingOff] = useState(false)
  const [writeOffReason, setWriteOffReason] = useState('')
  const [writeOffInvalid, setWriteOffInvalid] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<Payment | null>(null)
  const [removing, setRemoving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [showBookamatPrompt, setShowBookamatPrompt] = useState(false)
  const [bookamatBusy, setBookamatBusy] = useState<'sync' | 'attach' | 'reset' | null>(null)
  // null until loaded from the database.
  const [bookamat, setBookamat] = useState<BookamatInfo | null>(null)
  // An advance invoice deducted on an issued final invoice: its payments stay (MI022).
  const [moneyLock, setMoneyLock] = useState<{ id: string; number: string } | null>(null)
  const router = useRouter()
  const supabase = createClient()
  const uid = useId()
  const { t, lang } = useT()

  const kindLabel: Record<PaymentKind, string | null> = {
    payment: null, skonto: t('payments.skonto'), writeoff: t('payments.writtenOff'),
    credit: t('lifecycle.payments.creditNotePlain'), refund: t('lifecycle.credit.refund'), fee: t('books.fees.kind'),
  }

  // The balance counts every kind but 'fee': a Skonto taken, a write-off or an applied credit note
  // closes the invoice like money would; dunning fees and interest are paid on top of it.
  const settling = payments.filter(settlesBalance)
  const totalPaid = settledSum(payments)
  const balanceDue = roundCents(total - totalPaid)
  const state = paymentState(total, settling)
  // An empty or zero invoice has nothing to pay, so it is never "paid in full".
  const nothingDue = state === 'nothing_due'
  const fullyPaid = !nothingDue && balanceDue <= 0.005
  const overpaid = state === 'overpaid'
  const writtenOff = roundCents(payments.filter(p => p.kind === 'writeoff').reduce((s, p) => s + p.amount, 0))

  // Payments belong to issued, live invoices: a draft has no legal number yet and a cancelled
  // invoice has been replaced by its Storno.
  const canRecord = !!number && status !== 'cancelled' && !nothingDue

  // Skonto may be taken when the money arrived within the Skonto window and covers the total
  // less the Skonto; tiny leftovers (bank fees, rounding) can be written off instead.
  const skonto = skontoAmount(total, skontoPercent)
  const skontoDue = skontoDays != null ? skontoDeadline(date, skontoDays) : null
  const lastReceived = payments.filter(p => p.kind === 'payment').map(p => p.date).sort().at(-1) ?? null
  const offerSkonto = canRecord && !fullyPaid && skonto > 0 && !!skontoDue && !!lastReceived && lastReceived <= skontoDue && balanceDue <= skonto + 0.01
  // Under a euro left over is a rounding or bank-fee difference, closed in one click; a larger
  // uncollectible balance is written off with a reason.
  const offerWriteoff = canRecord && !fullyPaid && balanceDue < SMALL_DIFFERENCE
  const offerUncollectible = canRecord && !fullyPaid && balanceDue >= SMALL_DIFFERENCE

  useEffect(() => {
    if (!bookamatConfigured) return
    let active = true
    void fetchBookamatInfo(documentId).then(info => { if (active && info) setBookamat(info) })
    return () => { active = false }
  }, [bookamatConfigured, documentId])

  useEffect(() => {
    if (!number) return
    let active = true
    loadMoneyLock(createClient(), documentId)
      .then(lock => { if (active) setMoneyLock(lock) })
      .catch(err => console.error('[PaymentPanel] deduction lock not loaded:', err))
    return () => { active = false }
  }, [documentId, number])

  async function loadBookamat() {
    const info = await fetchBookamatInfo(documentId)
    if (info) setBookamat(info)
  }

  const bookings = bookamat?.bookings ?? []
  const synced = bookings.length > 0 || (!bookamat && !!bookamatBookingId)
  // What may exist in Bookamat without being recorded here; a reset has to name it.
  const unsettled = (bookamat?.pending ?? []).map(p => p.booking_id
    ? t('books.sync.booking', { id: p.booking_id, year: p.year })
    : t('books.sync.pendingTitle', { title: p.title, year: p.year }))
  const resetDesc = [
    bookings.length ? t('books.sync.resetDesc', { bookings: formatBookings(t, bookings) }) : null,
    unsettled.length ? t('books.sync.resetPendingDesc', { bookings: unsettled.join(', ') }) : null,
  ].filter(Boolean).join(' ') || t('payments.resetDesc')
  const canSync = hasMoneyToBook({ number, status, payments })
  // Money received in a year that has no booking yet (e.g. the rest paid after New Year), as far
  // as the bookings made do not cover it already; the sync books exactly this.
  const planned = canSync && bookings.length > 0 ? planBookings({ type: 'invoice', total, rows: payments }).bookings : []
  const unbookedMoney = unbookedPlan(planned, bookings).length > 0
  // A year without its own booking whose money an existing booking already covers (one booking
  // from before yearly bookings, or a payment date moved across New Year): only a reset helps.
  const coveredYears = unbookedMoney ? [] : planned.filter(p => !bookings.some(b => b.year === p.year && b.kind === p.kind)).map(p => p.year)

  async function recordRows(rows: NewPayment[]): Promise<boolean> {
    setSaving(true)
    try {
      const { data, error } = await supabase
        .from('payments')
        .insert(rows.map(row => ({ document_id: documentId, ...row })))
        .select()
      if (error) { toast.error(dbErrorMessage(t, error)); return false }

      const next = [...payments, ...(data ?? [])]
      setPayments(next)
      for (const row of rows) {
        await logEvent(supabase, documentId, 'payment_added', { amount: row.amount, date: row.date, kind: row.kind, method: row.method, reference: row.reference ?? undefined })
      }

      const fee = rows.find(r => r.kind === 'fee')
      const kind = rows[0].kind
      const label = fee && rows.length > 1 ? t('books.fees.recordedSplit', { amount: formatMoney(fee.amount, currency) })
        : kind === 'skonto' ? t('payments.skontoRecorded') : kind === 'writeoff' ? t('payments.writtenOffRecorded') : t('payments.paymentRecorded')
      if (settledSum(next) >= total - 0.005 && PAYABLE.includes(status)) {
        const { data: updated, error: statusErr } = await supabase.from('documents').update({ status: 'paid' }).eq('id', documentId).in('status', PAYABLE).select('id')
        if (statusErr) toast.error(dbErrorMessage(t, statusErr))
        else if (updated?.length) await logEvent(supabase, documentId, 'status_changed', { from: status, to: 'paid' })
        toast.success(t('payments.recordedAndPaid', { label }))
        if (!synced && bookamatConfigured) setShowBookamatPrompt(true)
      } else {
        toast.success(t('payments.recorded', { label }))
      }
      router.refresh()
      return true
    } finally {
      setSaving(false)
    }
  }

  async function addPayment() {
    if (!number) { toast.error(t('payments.issueBeforePayment')); return }
    if (status === 'cancelled') { toast.error(t('payments.cancelledInvoice')); return }
    const issue = paymentDateIssue(payDate, today())
    setDateIssue(issue)
    if (issue) { toast.error(t(issue === 'required' ? 'lifecycle.payments.dateRequired' : 'lifecycle.payments.dateFuture')); return }
    const amt = amount ?? 0
    if (!amt || amt <= 0) { toast.error(t('payments.invalidAmount')); return }
    // More than is open: most often a Mahnung paid with its fees and interest.
    if (amt > balanceDue + 0.005) { setOverpay({ amount: amt, choice: balanceDue > 0.005 ? 'fee' : 'payment' }); return }
    await submitPayment([paymentRow(amt)])
  }

  function paymentRow(amt: number, kind: PaymentKind = 'payment'): NewPayment {
    return { date: payDate, amount: amt, note: note.trim() || null, kind, method, reference: reference.trim() || null }
  }

  async function submitPayment(rows: NewPayment[]) {
    if (!(await recordRows(rows))) return
    setOverpay(null)
    setAmount(null)
    setNote('')
    setReference('')
  }

  async function confirmOverpay() {
    if (!overpay) return
    const open = Math.max(0, balanceDue)
    const excess = roundCents(overpay.amount - open)
    const rows = overpay.choice === 'payment' || excess <= 0.005
      ? [paymentRow(overpay.amount)]
      : [...(open > 0.005 ? [paymentRow(open)] : []), paymentRow(excess, 'fee')]
    await submitPayment(rows)
  }

  async function settleRemaining(kind: 'skonto' | 'writeoff', reason: string | null = null): Promise<boolean> {
    if (balanceDue <= 0.005) return false
    const settleNote = kind === 'skonto' ? `Skonto ${skontoPercent} %` : reason
    return recordRows([{ date: today(), amount: balanceDue, note: settleNote, kind, method: 'bank' }])
  }

  async function writeOffUncollectible() {
    const reason = writeOffReason.trim()
    if (!reason) { setWriteOffInvalid(true); return }
    if (await settleRemaining('writeoff', reason)) {
      setWritingOff(false)
      setWriteOffReason('')
    }
  }

  async function removePayment(id: string) {
    const removed = payments.find(p => p.id === id)
    const next = payments.filter(p => p.id !== id)
    const reopen = status === 'paid' && settledSum(next) < total - 0.005
    setRemoving(true)
    // One transaction: the row goes and a paid invoice that is open again reopens (the only way
    // the lifecycle trigger lets paid go back to sent/overdue).
    const { data: reopened, error } = await supabase.rpc('remove_payment', { p_payment_id: id, p_reopen: reopen })
    if (error) { toast.error(dbErrorMessage(t, error)); setRemoving(false); return }
    if (removed) await logEvent(supabase, documentId, 'payment_removed', { amount: removed.amount, date: removed.date, kind: removed.kind, method: removed.method })
    if (reopened) await logEvent(supabase, documentId, 'status_changed', { from: 'paid', to: reopened })
    setPayments(next)

    setRemoving(false)
    setPendingRemove(null)
    router.refresh()
  }

  async function syncToBookamat() {
    setShowBookamatPrompt(false)
    setBookamatBusy('sync')
    const res = await requestBookamatSync(documentId)
    setBookamatBusy(null)
    if (!res.ok) {
      toast.error(t('books.sync.failed', { error: bookamatErrorMessage(t, res.payload) }))
      void loadBookamat()
      return
    }
    const { created, bookings: all, pdf, fees } = res.data
    setBookamat({ bookings: all, error: null, pending: [] })
    const made = formatBookings(t, created)
    if (!created.length) toast.info(t('books.sync.alreadySynced', { bookings: formatBookings(t, all) }))
    else if (pdf.error) toast.warning(t('books.sync.pdfNotAttached', { bookings: made, error: pdf.error }))
    else if (pdf.attached) toast.success(t('books.sync.syncedWithPdf', { bookings: made }))
    else toast.success(t('books.sync.syncedToast', { bookings: made }))
    if (fees > 0) toast.info(t('books.sync.feesNotBooked', { amount: formatMoney(fees, currency) }), { duration: 8000 })
  }

  async function attachAgain() {
    setBookamatBusy('attach')
    const res = await fetch('/api/bookamat/attach-pdf', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    }).catch(() => null)
    setBookamatBusy(null)
    const payload = res ? await res.json().catch(() => ({})) : {}
    if (!res?.ok) { toast.error(t('books.sync.attachFailed', { error: bookamatErrorMessage(t, payload) })); return }
    const count = Number(payload.attached) || 0
    if (payload.error) toast.warning(t('books.sync.attachFailed', { error: String(payload.error) }))
    else toast.success(n(count, t('books.sync.attachedOne'), t('books.sync.attachedOther', { count })))
    void loadBookamat()
  }

  async function resetSync() {
    setBookamatBusy('reset')
    const res = await fetch('/api/bookamat/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    }).catch(() => null)
    setBookamatBusy(null)
    if (!res?.ok) {
      const payload = res ? await res.json().catch(() => ({})) : {}
      toast.error(bookamatErrorMessage(t, payload))
      return
    }
    setBookamat({ bookings: [], error: null, pending: [] })
    setConfirmReset(false)
    toast.success(t('payments.syncReset'))
  }

  const linkBtn = 'text-xs px-2 py-2 -my-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 transition-colors disabled:opacity-50'
  const overpayExcess = overpay ? roundCents(overpay.amount - Math.max(0, balanceDue)) : 0

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">{t('payments.title')}</h2>
        <div className="text-sm text-neutral-500 dark:text-neutral-400 flex items-center gap-2 flex-wrap">
          {status === 'cancelled' ? (
            <span className="font-semibold">{t('lifecycle.payments.cancelled')}</span>
          ) : nothingDue ? (
            <span className="font-semibold">{t('lifecycle.payments.nothingToPay')}</span>
          ) : (
            <>
              <span>
                {t('payments.balance')} <span className={overpaid ? 'text-red-600 font-semibold' : state === 'written_off' ? 'text-orange-600 dark:text-orange-400 font-semibold' : fullyPaid ? 'text-green-600 font-semibold' : 'font-semibold text-amber-600'}>
                  {overpaid ? t('payments.overpaidBy', { amount: formatMoney(-balanceDue, currency) })
                    : state === 'written_off' ? t('lifecycle.payments.writtenOff', { amount: formatMoney(writtenOff, currency) })
                    : fullyPaid ? t('payments.paidInFull') : formatMoney(balanceDue, currency)}
                </span>
              </span>
              {state === 'partially_paid' && <StatusBadge status="partially_paid" label={t('lifecycle.states.partially_paid')} />}
            </>
          )}
        </div>
      </div>

      {payments.length > 0 && (
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
          {payments.map(p => (
            <div key={p.id} className="flex items-center py-1 sm:py-2 gap-x-3 gap-y-0.5 flex-wrap">
              <span className="text-neutral-500 dark:text-neutral-400 w-24 shrink-0">{formatDate(p.date, lang)}</span>
              <span className="font-medium">{formatMoney(p.amount, currency)}</span>
              {p.kind === 'credit' && p.credit_note_id ? (
                <Link href={`/credit-notes/${p.credit_note_id}`} className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-300 hover:underline shrink-0">
                  {p.note ? t('lifecycle.payments.creditNote', { number: p.note }) : t('lifecycle.payments.creditNotePlain')}
                </Link>
              ) : kindLabel[p.kind] && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 shrink-0">{kindLabel[p.kind]}</span>
              )}
              {p.method === 'cash' && (p.kind === 'payment' || p.kind === 'fee') && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 shrink-0">{t('payments.cashBadge')}</span>
              )}
              {p.reference && <span className="text-xs text-neutral-500 dark:text-neutral-400 font-mono truncate min-w-0">{t('lifecycle.payments.referenceShort', { reference: p.reference })}</span>}
              {p.note && p.kind !== 'credit' && <span className="text-neutral-500 dark:text-neutral-400 flex-1 truncate min-w-0">{p.note}</span>}
              {!(moneyLock && p.kind === 'payment') && (
                <button
                  type="button"
                  onClick={() => setPendingRemove(p)}
                  aria-label={t('payments.removePayment', { amount: formatMoney(p.amount, currency), date: formatDate(p.date, lang) })}
                  className="ml-auto h-11 w-11 -mr-2 sm:h-8 sm:w-8 sm:-mr-1 shrink-0 flex items-center justify-center rounded-md text-neutral-500 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
                >
                  <Trash2 size={14} />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {moneyLock && payments.some(p => p.kind === 'payment') && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('records.deposits.paymentsLocked', { number: moneyLock.number })}{' '}
          <Link href={`/invoices/${moneyLock.id}`} className="underline underline-offset-2 hover:text-neutral-800 dark:hover:text-neutral-100">{t('deposits.history.openFinal')}</Link>
        </p>
      )}

      {(offerSkonto || offerWriteoff || offerUncollectible) && (
        <div className="flex flex-wrap gap-2">
          {offerSkonto && (
            <Button type="button" variant="outline" onClick={() => void settleRemaining('skonto')} disabled={saving} className="text-xs">
              {t('payments.settleSkonto', { amount: formatMoney(balanceDue, currency) })}
            </Button>
          )}
          {offerWriteoff && (
            <Button type="button" variant="outline" onClick={() => void settleRemaining('writeoff')} disabled={saving} className="text-xs">
              {t('payments.writeOff', { amount: formatMoney(balanceDue, currency) })}
            </Button>
          )}
          {offerUncollectible && (
            <Button type="button" variant="outline" onClick={() => { setWriteOffInvalid(false); setWritingOff(true) }} disabled={saving} className="text-xs">
              {t('lifecycle.payments.writeOffOpen')}
            </Button>
          )}
        </div>
      )}

      {!fullyPaid && !number && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 pt-1">{t('payments.issueFirst')}</p>
      )}
      {!fullyPaid && canRecord && (
        <div className="space-y-2 pt-1">
          <div className="flex gap-2">
            <Input
              type="date"
              required
              max={today()}
              aria-label={t('payments.paymentDate')}
              aria-invalid={dateIssue ? true : undefined}
              value={payDate}
              onChange={e => { setPayDate(e.target.value); setDateIssue(null) }}
              className="flex-1 min-w-0"
            />
            <MoneyInput
              aria-label={t('payments.amount', { currency })}
              placeholder={t('payments.amount', { currency })}
              value={amount}
              onValueChange={setAmount}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex gap-2">
            <Select
              aria-label={t('payments.paymentMethod')}
              value={method}
              onChange={e => setMethod(e.target.value as PaymentMethod)}
              className="w-auto shrink-0"
            >
              <option value="bank">{t('payments.methodBank')}</option>
              <option value="cash">{t('payments.methodCash')}</option>
            </Select>
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
            <Button
              type="button"
              onClick={() => void addPayment()}
              disabled={saving}
              className="shrink-0"
            >
              <Plus size={13} />
              {saving ? t('common.saving') : t('payments.add')}
            </Button>
          </div>
        </div>
      )}

      {bookamatConfigured && (
        <div className="space-y-1.5 pt-2 border-t border-neutral-100 dark:border-neutral-800">
          {synced ? (
            <div className="flex items-center justify-between gap-x-3 gap-y-1 flex-wrap">
              <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400 min-w-0">
                <CheckCircle2 size={13} className="shrink-0" />
                <span className="break-words">{bookings.length ? t('books.sync.synced', { bookings: formatBookings(t, bookings) }) : t('payments.synced')}</span>
              </span>
              <span className="flex items-center gap-1 flex-wrap">
                {unbookedMoney && (
                  <button type="button" onClick={() => setShowBookamatPrompt(true)} disabled={!!bookamatBusy} className={linkBtn}>
                    {t('books.sync.newMoney')}
                  </button>
                )}
                {bookings.length > 0 && (
                  <button type="button" onClick={() => void attachAgain()} disabled={!!bookamatBusy} className={linkBtn}>
                    {bookamatBusy === 'attach' ? t('books.sync.attaching') : t('books.sync.attachAgain')}
                  </button>
                )}
                <button type="button" onClick={() => setConfirmReset(true)} disabled={!!bookamatBusy} className={`${linkBtn} hover:text-red-500 dark:hover:text-red-400`}>
                  {t('payments.resetSync')}
                </button>
              </span>
            </div>
          ) : canSync ? (
            <div className="flex items-center justify-between gap-x-3 gap-y-1 flex-wrap">
              <button
                type="button"
                onClick={() => setShowBookamatPrompt(true)}
                disabled={!!bookamatBusy}
                className={`${linkBtn} -mx-2 font-medium`}
              >
                {bookamatBusy === 'sync' ? t('payments.syncing') : bookamat?.error ? t('books.sync.retry') : t('payments.syncTo')}
              </button>
              {unsettled.length > 0 && (
                <button type="button" onClick={() => setConfirmReset(true)} disabled={!!bookamatBusy} className={`${linkBtn} hover:text-red-500 dark:hover:text-red-400`}>
                  {t('payments.resetSync')}
                </button>
              )}
            </div>
          ) : (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">{t('payments.syncAvailableWhenPaid')}</span>
          )}
          {coveredYears.length > 0 && (
            <p className="text-xs text-neutral-500 dark:text-neutral-400 break-words">{t('books.sync.coveredElsewhere', { years: coveredYears.join(', '), bookings: formatBookings(t, bookings) })}</p>
          )}
          {bookamat?.error && (
            <p role="status" className="text-xs text-red-600 dark:text-red-400 break-words">{t('books.sync.lastError', { error: bookamat.error })}</p>
          )}
        </div>
      )}

      <ConfirmDialog
        open={!!overpay}
        title={t('books.fees.splitTitle')}
        description={overpay ? t('books.fees.splitDesc', { amount: formatMoney(overpay.amount, currency), excess: formatMoney(overpayExcess, currency), balance: formatMoney(Math.max(balanceDue, 0), currency) }) : undefined}
        confirmLabel={saving ? t('common.saving') : t('books.fees.record')}
        busy={saving}
        onConfirm={() => void confirmOverpay()}
        onCancel={() => setOverpay(null)}
      >
        {overpay && (
          <fieldset className="space-y-2">
            <legend className="sr-only">{t('books.fees.splitTitle')}</legend>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" name={`${uid}-overpay`} className="mt-1 shrink-0" checked={overpay.choice === 'fee'} onChange={() => setOverpay({ ...overpay, choice: 'fee' })} />
              <span>
                {t('books.fees.splitFee', { balance: formatMoney(Math.max(balanceDue, 0), currency), excess: formatMoney(overpayExcess, currency) })}
                <span className="block text-xs text-neutral-500 dark:text-neutral-400 mt-0.5">{t('books.fees.splitFeeHint')}</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm cursor-pointer">
              <input type="radio" name={`${uid}-overpay`} className="mt-1 shrink-0" checked={overpay.choice === 'payment'} onChange={() => setOverpay({ ...overpay, choice: 'payment' })} />
              <span>{t('books.fees.splitOverpay', { amount: formatMoney(overpay.amount, currency) })}</span>
            </label>
          </fieldset>
        )}
      </ConfirmDialog>

      <ConfirmDialog
        open={writingOff}
        title={t('lifecycle.payments.writeOffTitle', { amount: formatMoney(Math.max(balanceDue, 0), currency) })}
        description={t('lifecycle.payments.writeOffDesc')}
        confirmLabel={saving ? t('common.saving') : t('lifecycle.payments.writeOffConfirm')}
        destructive
        busy={saving}
        onConfirm={() => void writeOffUncollectible()}
        onCancel={() => setWritingOff(false)}
      >
        <div className="space-y-1">
          <label htmlFor={`${uid}-writeoff-reason`} className="text-xs font-medium text-neutral-600 dark:text-neutral-400">{t('lifecycle.payments.writeOffReason')}</label>
          <Input
            id={`${uid}-writeoff-reason`}
            value={writeOffReason}
            maxLength={200}
            placeholder={t('lifecycle.payments.writeOffReasonPlaceholder')}
            aria-invalid={writeOffInvalid || undefined}
            aria-describedby={writeOffInvalid ? `${uid}-writeoff-error` : undefined}
            onChange={e => { setWriteOffReason(e.target.value); setWriteOffInvalid(false) }}
          />
          {writeOffInvalid && <p id={`${uid}-writeoff-error`} role="alert" className="text-xs text-red-600 dark:text-red-400">{t('lifecycle.payments.writeOffReasonRequired')}</p>}
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!pendingRemove}
        title={t('payments.removeTitle')}
        description={pendingRemove ? t('payments.removeDesc', { amount: formatMoney(pendingRemove.amount, currency), date: formatDate(pendingRemove.date, lang) }) : undefined}
        confirmLabel={removing ? t('common.removing') : t('common.remove')}
        destructive
        busy={removing}
        onConfirm={() => { if (pendingRemove) void removePayment(pendingRemove.id) }}
        onCancel={() => setPendingRemove(null)}
      />

      <ConfirmDialog
        open={confirmReset}
        title={t('payments.resetTitle')}
        description={resetDesc}
        confirmLabel={bookamatBusy === 'reset' ? t('payments.resetting') : t('payments.resetSync')}
        destructive
        busy={bookamatBusy === 'reset'}
        onConfirm={() => void resetSync()}
        onCancel={() => setConfirmReset(false)}
      />

      <ConfirmDialog
        open={showBookamatPrompt}
        title={t('payments.syncTitle')}
        description={t('payments.syncDesc')}
        confirmLabel={bookamatBusy === 'sync' ? t('payments.syncing') : t('payments.syncButton')}
        cancelLabel={t('common.skip')}
        busy={bookamatBusy === 'sync'}
        onConfirm={() => void syncToBookamat()}
        onCancel={() => setShowBookamatPrompt(false)}
      />
    </div>
  )
}
