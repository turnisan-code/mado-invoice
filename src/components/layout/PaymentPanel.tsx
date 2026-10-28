'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { formatMoney, today, roundCents, skontoAmount, skontoDeadline } from '@/lib/utils/document'
import { Trash2, Plus, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { MoneyInput } from '@/components/ui/MoneyInput'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import type { Currency, PaymentKind } from '@/types'

interface Payment {
  id: string
  date: string
  amount: number
  note: string | null
  kind: PaymentKind
}

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
  bookamatBookingId?: string | null
  generatePdfForBookamat?: () => Promise<{ base64: string; filename: string } | null>
}

const KIND_LABEL: Record<PaymentKind, string | null> = { payment: null, skonto: 'Skonto', writeoff: 'Written off' }

export default function PaymentPanel({
  documentId, number, status, date, total, payments: initial, currency, skontoPercent, skontoDays,
  bookamatConfigured, bookamatBookingId, generatePdfForBookamat,
}: Props) {
  const [payments, setPayments] = useState<Payment[]>(initial)
  // Payments can also be added elsewhere on the page (status pill → paid); follow server refreshes.
  const [seenInitial, setSeenInitial] = useState(initial)
  if (initial !== seenInitial) {
    setSeenInitial(initial)
    setPayments(initial)
  }
  const [payDate, setPayDate] = useState(today())
  const [amount, setAmount] = useState<number | null>(null)
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmOverpay, setConfirmOverpay] = useState(false)
  const [pendingRemove, setPendingRemove] = useState<Payment | null>(null)
  const [removing, setRemoving] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showBookamatPrompt, setShowBookamatPrompt] = useState(false)
  const [syncingBookamat, setSyncingBookamat] = useState(false)
  const [bookamatId, setBookamatId] = useState(bookamatBookingId ?? null)
  const router = useRouter()
  const supabase = createClient()

  // The balance counts every kind: a Skonto taken or a write-off closes the invoice like money would.
  const totalPaid = roundCents(payments.reduce((s, p) => s + p.amount, 0))
  const balanceDue = roundCents(total - totalPaid)
  const fullyPaid = balanceDue <= 0.005
  const overpaid = balanceDue < -0.005

  // Payments belong to issued, live invoices: a draft has no legal number yet and a cancelled
  // invoice has been replaced by its Storno.
  const canRecord = !!number && status !== 'cancelled'

  // Skonto may be taken when the money arrived within the Skonto window and covers the total
  // less the Skonto; tiny leftovers (bank fees, rounding) can be written off instead.
  const skonto = skontoAmount(total, skontoPercent)
  const skontoDue = skontoDays != null ? skontoDeadline(date, skontoDays) : null
  const lastReceived = payments.filter(p => p.kind === 'payment').map(p => p.date).sort().at(-1) ?? null
  const offerSkonto = canRecord && !fullyPaid && skonto > 0 && !!skontoDue && !!lastReceived && lastReceived <= skontoDue && balanceDue <= skonto + 0.01
  const offerWriteoff = canRecord && !fullyPaid && balanceDue < 1

  async function recordRow(row: { date: string; amount: number; note: string | null; kind: PaymentKind }) {
    setSaving(true)
    const { data, error } = await supabase
      .from('payments')
      .insert({ document_id: documentId, ...row })
      .select()
      .single()
    if (error) { toast.error(error.message); setSaving(false); return }

    const next = [...payments, data]
    setPayments(next)

    const newTotal = next.reduce((s, p) => s + p.amount, 0)
    const label = row.kind === 'skonto' ? 'Skonto recorded' : row.kind === 'writeoff' ? 'Remaining balance written off' : 'Payment recorded'
    if (newTotal >= total - 0.005) {
      await supabase.from('documents').update({ status: 'paid' }).eq('id', documentId)
      toast.success(`${label} — invoice marked as paid.`)
      if (!bookamatId && bookamatConfigured) {
        setShowBookamatPrompt(true)
      }
    } else {
      toast.success(`${label}.`)
    }

    setSaving(false)
    router.refresh()
  }

  async function addPayment(allowOverpayment = false) {
    if (!number) { toast.error('Issue the invoice before recording a payment.'); return }
    if (status === 'cancelled') { toast.error('This invoice is cancelled — record payments on the replacement invoice.'); return }
    const amt = amount ?? 0
    if (!amt || amt <= 0) { toast.error('Enter a valid amount.'); return }
    if (amt > balanceDue + 0.005 && !allowOverpayment) { setConfirmOverpay(true); return }
    setConfirmOverpay(false)
    await recordRow({ date: payDate, amount: amt, note: note || null, kind: 'payment' })
    setAmount(null)
    setNote('')
  }

  async function settleRemaining(kind: 'skonto' | 'writeoff') {
    if (balanceDue <= 0.005) return
    const settleNote = kind === 'skonto' ? `Skonto ${skontoPercent} %` : null
    await recordRow({ date: today(), amount: balanceDue, note: settleNote, kind })
  }

  async function removePayment(id: string) {
    setRemoving(true)
    const { error } = await supabase.from('payments').delete().eq('id', id)
    if (error) { toast.error(error.message); setRemoving(false); return }
    const next = payments.filter(p => p.id !== id)
    setPayments(next)

    const newTotal = next.reduce((s, p) => s + p.amount, 0)
    if (status === 'paid' && newTotal < total - 0.005) {
      await supabase.from('documents').update({ status: 'sent' }).eq('id', documentId)
    }

    setRemoving(false)
    setPendingRemove(null)
    router.refresh()
  }

  async function resetBookamatSync() {
    setResetting(true)
    const { error } = await supabase
      .from('documents')
      .update({ bookamat_booking_id: null })
      .eq('id', documentId)
    setResetting(false)
    if (error) { toast.error(error.message); return }
    setBookamatId(null)
    setConfirmReset(false)
    toast.success('Sync reset — you can sync again after deleting the booking in Bookamat.')
  }

  async function syncToBookamat() {
    setSyncingBookamat(true)
    setShowBookamatPrompt(false)

    // Generate PDF FIRST — before any state changes that could re-render
    // DocumentBuilder and kill the react-pdf worker mid-generation
    let pdfResult: { base64: string; filename: string } | null = null
    if (generatePdfForBookamat) {
      try {
        pdfResult = await generatePdfForBookamat()
      } catch (err) {
        console.warn('PDF pre-generation failed:', err)
      }
    }

    const res = await fetch('/api/bookamat/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentId }),
    })

    if (!res.ok) {
      setSyncingBookamat(false)
      if (res.status === 409) {
        toast.info('Already synced to Bookamat.')
      } else {
        const { error } = await res.json().catch(() => ({ error: 'Unknown error' }))
        toast.error(`Bookamat sync failed: ${error}`)
      }
      return
    }

    const { bookingId, country, year } = await res.json()
    setBookamatId(String(bookingId))

    // Attach pre-generated PDF
    if (!pdfResult) {
      toast.success('Synced to Bookamat.')
    } else {
      try {
        const attachRes = await fetch('/api/bookamat/attach-pdf', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bookingId, pdfBase64: pdfResult.base64, filename: pdfResult.filename, country, year }),
        })

        if (attachRes.ok) {
          toast.success('Synced to Bookamat — invoice PDF attached.')
        } else {
          const { error } = await attachRes.json().catch(() => ({ error: 'Unknown error' }))
          toast.warning(`Synced, but PDF not attached: ${error}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        toast.warning(`Synced, but PDF not attached: ${msg}`)
      }
    }

    setSyncingBookamat(false)
  }

  const settleBtn = 'text-xs px-2.5 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50 text-neutral-600 dark:text-neutral-300'

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-4 sm:p-6 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Payments</h2>
        <div className="text-sm text-neutral-500 dark:text-neutral-400">
          Balance: <span className={overpaid ? 'text-red-600 font-semibold' : fullyPaid ? 'text-green-600 font-semibold' : 'font-semibold text-amber-600'}>
            {overpaid ? `Overpaid by ${formatMoney(-balanceDue, currency)}` : fullyPaid ? 'Paid in full' : formatMoney(balanceDue, currency)}
          </span>
        </div>
      </div>

      {payments.length > 0 && (
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
          {payments.map(p => (
            <div key={p.id} className="flex items-center py-1 sm:py-2 gap-3">
              <span className="text-neutral-500 dark:text-neutral-400 w-24 shrink-0">{p.date}</span>
              <span className="font-medium">{formatMoney(p.amount, currency)}</span>
              {KIND_LABEL[p.kind] && (
                <span className="text-xs px-1.5 py-0.5 rounded bg-neutral-100 dark:bg-neutral-800 text-neutral-500 dark:text-neutral-400 shrink-0">{KIND_LABEL[p.kind]}</span>
              )}
              {p.note && <span className="text-neutral-500 dark:text-neutral-400 flex-1 truncate min-w-0">{p.note}</span>}
              <button
                type="button"
                onClick={() => setPendingRemove(p)}
                aria-label={`Remove payment of ${formatMoney(p.amount, currency)} from ${p.date}`}
                className="ml-auto h-11 w-11 -mr-2 sm:h-8 sm:w-8 sm:-mr-1 shrink-0 flex items-center justify-center rounded-md text-neutral-400 dark:text-neutral-500 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}

      {(offerSkonto || offerWriteoff) && (
        <div className="flex flex-wrap gap-2">
          {offerSkonto && (
            <button type="button" onClick={() => settleRemaining('skonto')} disabled={saving} className={settleBtn}>
              Settle remaining {formatMoney(balanceDue, currency)} as Skonto
            </button>
          )}
          {offerWriteoff && (
            <button type="button" onClick={() => settleRemaining('writeoff')} disabled={saving} className={settleBtn}>
              Write off remaining {formatMoney(balanceDue, currency)}
            </button>
          )}
        </div>
      )}

      {!fullyPaid && !number && (
        <p className="text-xs text-neutral-500 dark:text-neutral-400 pt-1">Issue the invoice before recording payments.</p>
      )}
      {!fullyPaid && canRecord && (
        <div className="space-y-2 pt-1">
          <div className="flex gap-2">
            <Input
              type="date"
              aria-label="Payment date"
              value={payDate}
              onChange={e => setPayDate(e.target.value)}
              className="flex-1 min-w-0"
            />
            <MoneyInput
              aria-label={`Amount (${currency})`}
              placeholder={`Amount (${currency})`}
              value={amount}
              onValueChange={setAmount}
              className="flex-1 min-w-0"
            />
          </div>
          <div className="flex gap-2">
            <Input
              aria-label="Note (optional)"
              placeholder="Note (optional)"
              value={note}
              onChange={e => setNote(e.target.value)}
              className="flex-1 min-w-0"
            />
            <Button
              type="button"
              onClick={() => addPayment()}
              disabled={saving}
              size="sm"
              className="shrink-0 flex items-center gap-1.5 h-8"
            >
              <Plus size={13} />
              {saving ? 'Saving…' : 'Add'}
            </Button>
          </div>
        </div>
      )}

      {/* Bookamat sync status */}
      {bookamatConfigured && (
        <div className="flex items-center justify-between gap-3 flex-wrap pt-2 border-t border-neutral-100 dark:border-neutral-800">
          {bookamatId ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 size={13} /> Synced to Bookamat
              </span>
              <button
                type="button"
                onClick={() => setConfirmReset(true)}
                className="text-xs px-2 py-2 -my-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-red-500 dark:hover:text-red-400 transition-colors"
              >
                Reset sync
              </button>
            </div>
          ) : fullyPaid ? (
            <button
              type="button"
              onClick={() => setShowBookamatPrompt(true)}
              className="text-xs font-medium px-2 py-2 -mx-2 -my-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-100 transition-colors flex items-center gap-1"
            >
              Sync to Bookamat →
            </button>
          ) : (
            <span className="text-xs text-neutral-500 dark:text-neutral-400">Sync to Bookamat becomes available once the invoice is fully paid</span>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmOverpay}
        title="Record an overpayment?"
        description={`${formatMoney(amount ?? 0, currency)} is more than the open balance of ${formatMoney(Math.max(balanceDue, 0), currency)}.`}
        confirmLabel="Record anyway"
        busy={saving}
        onConfirm={() => void addPayment(true)}
        onCancel={() => setConfirmOverpay(false)}
      />

      <ConfirmDialog
        open={!!pendingRemove}
        title="Remove this payment?"
        description={pendingRemove ? `${formatMoney(pendingRemove.amount, currency)} from ${pendingRemove.date} is removed and the open balance goes back up.` : undefined}
        confirmLabel={removing ? 'Removing…' : 'Remove'}
        destructive
        busy={removing}
        onConfirm={() => { if (pendingRemove) void removePayment(pendingRemove.id) }}
        onCancel={() => setPendingRemove(null)}
      />

      <ConfirmDialog
        open={confirmReset}
        title="Reset the Bookamat sync?"
        description="Only do this after deleting the booking in Bookamat; the invoice can then be synced again."
        confirmLabel={resetting ? 'Resetting…' : 'Reset sync'}
        busy={resetting}
        onConfirm={resetBookamatSync}
        onCancel={() => setConfirmReset(false)}
      />

      <ConfirmDialog
        open={showBookamatPrompt}
        title="Sync to Bookamat?"
        description="This invoice is fully paid. Add it to your Bookamat bookkeeping?"
        confirmLabel={syncingBookamat ? 'Syncing…' : 'Sync to Bookamat'}
        cancelLabel="Skip"
        busy={syncingBookamat}
        onConfirm={syncToBookamat}
        onCancel={() => setShowBookamatPrompt(false)}
      />
    </div>
  )
}
