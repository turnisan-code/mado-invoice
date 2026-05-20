'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { formatMoney } from '@/lib/utils/document'
import { Trash2, Plus, CheckCircle2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Currency } from '@/types'

interface Payment {
  id: string
  date: string
  amount: number
  note: string | null
}

interface Props {
  documentId: string
  total: number
  payments: Payment[]
  currency: Currency
  bookamatConfigured?: boolean
  bookamatBookingId?: string | null
  generatePdfForBookamat?: () => Promise<{ base64: string; filename: string } | null>
}

export default function PaymentPanel({ documentId, total, payments: initial, currency, bookamatConfigured, bookamatBookingId, generatePdfForBookamat }: Props) {
  const [payments, setPayments] = useState<Payment[]>(initial)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
  const [showBookamatPrompt, setShowBookamatPrompt] = useState(false)
  const [syncingBookamat, setSyncingBookamat] = useState(false)
  const [bookamatId, setBookamatId] = useState(bookamatBookingId ?? null)
  const router = useRouter()
  const supabase = createClient()

  const totalPaid = payments.reduce((s, p) => s + p.amount, 0)
  const balanceDue = total - totalPaid
  const fullyPaid = balanceDue <= 0.005

  async function addPayment() {
    const amt = parseFloat(amount)
    if (!amt || amt <= 0) { toast.error('Enter a valid amount.'); return }
    setSaving(true)

    const { data, error } = await supabase
      .from('payments')
      .insert({ document_id: documentId, date, amount: amt, note: note || null })
      .select()
      .single()

    if (error) { toast.error(error.message); setSaving(false); return }

    const next = [...payments, data]
    setPayments(next)
    setAmount('')
    setNote('')

    const newTotal = next.reduce((s, p) => s + p.amount, 0)
    if (newTotal >= total - 0.005) {
      await supabase.from('documents').update({ status: 'paid' }).eq('id', documentId)
      toast.success('Payment recorded — invoice marked as paid.')
      if (!bookamatId && bookamatConfigured) {
        setShowBookamatPrompt(true)
      }
    } else {
      toast.success('Payment recorded.')
    }

    setSaving(false)
    router.refresh()
  }

  async function removePayment(id: string) {
    const { error } = await supabase.from('payments').delete().eq('id', id)
    if (error) { toast.error(error.message); return }
    const next = payments.filter(p => p.id !== id)
    setPayments(next)

    const newTotal = next.reduce((s, p) => s + p.amount, 0)
    if (newTotal < total - 0.005) {
      await supabase.from('documents').update({ status: 'sent' }).eq('id', documentId)
    }

    router.refresh()
  }

  async function resetBookamatSync() {
    const { error } = await supabase
      .from('documents')
      .update({ bookamat_booking_id: null })
      .eq('id', documentId)
    if (error) { toast.error(error.message); return }
    setBookamatId(null)
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

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Payments</h2>
        <div className="text-sm text-neutral-500 dark:text-neutral-400">
          Balance: <span className={fullyPaid ? 'text-green-600 font-semibold' : 'font-semibold text-amber-600'}>
            {fullyPaid ? 'Paid in full' : formatMoney(balanceDue, currency)}
          </span>
        </div>
      </div>

      {payments.length > 0 && (
        <div className="divide-y divide-neutral-100 dark:divide-neutral-800 text-sm">
          {payments.map(p => (
            <div key={p.id} className="flex items-center py-2 gap-3">
              <span className="text-neutral-400 dark:text-neutral-500 w-24 shrink-0">{p.date}</span>
              <span className="font-medium">{formatMoney(p.amount, currency)}</span>
              {p.note && <span className="text-neutral-400 dark:text-neutral-500 flex-1 truncate">{p.note}</span>}
              <button
                onClick={() => removePayment(p.id)}
                className="ml-auto text-neutral-300 hover:text-red-500 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      {!fullyPaid && (
        <div className="flex gap-2 pt-1">
          <Input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="text-sm w-36 shrink-0"
          />
          <Input
            type="number"
            placeholder={`Amount (${currency})`}
            value={amount}
            onChange={e => setAmount(e.target.value)}
            className="text-sm w-36 shrink-0"
            step="0.01"
            min="0"
          />
          <Input
            placeholder="Note (optional)"
            value={note}
            onChange={e => setNote(e.target.value)}
            className="text-sm flex-1"
          />
          <Button
            type="button"
            onClick={addPayment}
            disabled={saving}
            size="sm"
            className="shrink-0 flex items-center gap-1.5"
          >
            <Plus size={13} />
            {saving ? 'Saving…' : 'Add payment'}
          </Button>
        </div>
      )}

      {/* Bookamat sync status */}
      {bookamatConfigured && (
        <div className="flex items-center justify-between pt-2 border-t border-neutral-100 dark:border-neutral-800">
          {bookamatId ? (
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-1.5 text-xs text-green-600 dark:text-green-400">
                <CheckCircle2 size={13} /> Synced to Bookamat
              </span>
              <button
                type="button"
                onClick={resetBookamatSync}
                className="text-xs text-neutral-300 dark:text-neutral-600 hover:text-red-400 dark:hover:text-red-500 transition-colors"
              >
                Reset sync
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setShowBookamatPrompt(true)}
              className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
            >
              Sync to Bookamat →
            </button>
          )}
        </div>
      )}

      {/* Bookamat confirmation modal */}
      {showBookamatPrompt && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 w-full max-w-sm space-y-4 shadow-xl">
            <div>
              <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">Sync to Bookamat?</h3>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
                This invoice is fully paid. Add it to your Bookamat bookkeeping?
              </p>
            </div>
            <div className="flex gap-2 justify-end">
              <button
                type="button"
                onClick={() => setShowBookamatPrompt(false)}
                className="text-sm px-4 py-2 rounded-lg border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors"
              >
                Skip
              </button>
              <button
                type="button"
                onClick={syncToBookamat}
                disabled={syncingBookamat}
                className="text-sm px-4 py-2 rounded-lg bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-200 transition-colors disabled:opacity-50"
              >
                {syncingBookamat ? 'Syncing…' : 'Sync to Bookamat'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
