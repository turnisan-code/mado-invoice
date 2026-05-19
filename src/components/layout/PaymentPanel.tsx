'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { formatMoney } from '@/lib/utils/document'
import { Trash2, Plus } from 'lucide-react'
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
}

export default function PaymentPanel({ documentId, total, payments: initial, currency }: Props) {
  const [payments, setPayments] = useState<Payment[]>(initial)
  const [date, setDate] = useState(new Date().toISOString().split('T')[0])
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)
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

  return (
    <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 p-6 space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300">Payments</h2>
        <div className="text-sm text-neutral-500 dark:text-neutral-400">
          Balance: <span className={fullyPaid ? 'text-green-600 font-semibold' : 'font-semibold text-neutral-900 dark:text-neutral-100'}>
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
    </div>
  )
}
