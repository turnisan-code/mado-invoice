'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'cancelled'] as const
const CREDIT_NOTE_STATUSES = ['draft', 'sent', 'cancelled'] as const

const DESTRUCTIVE = new Set(['cancelled', 'rejected'])

const statusColor: Record<string, string> = {
  draft:     'text-neutral-500 bg-neutral-100 border-neutral-200 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-400',
  sent:      'text-blue-700 bg-blue-50 border-blue-200 dark:bg-blue-950 dark:border-blue-800 dark:text-blue-300',
  paid:      'text-green-700 bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800 dark:text-green-300',
  overdue:   'text-red-700 bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800 dark:text-red-300',
  accepted:  'text-green-700 bg-green-50 border-green-200 dark:bg-green-950 dark:border-green-800 dark:text-green-300',
  rejected:  'text-red-700 bg-red-50 border-red-200 dark:bg-red-950 dark:border-red-800 dark:text-red-300',
  cancelled: 'text-neutral-400 bg-neutral-50 border-neutral-200 dark:bg-neutral-800 dark:border-neutral-700',
}

const itemColor: Record<string, string> = {
  paid:      'text-green-700 dark:text-green-400',
  overdue:   'text-red-600 dark:text-red-400',
  accepted:  'text-green-700 dark:text-green-400',
  rejected:  'text-red-600 dark:text-red-400',
  cancelled: 'text-neutral-400',
}

interface Props {
  document: { id: string; status: string; type: string; number: string | null }
}

export default function DocumentStatusBar({ document: doc }: Props) {
  const [status, setStatus] = useState(doc.status)
  const [seenStatus, setSeenStatus] = useState(doc.status)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const supabase = createClient()
  const allStatuses: readonly string[] = doc.type === 'quote' ? QUOTE_STATUSES : doc.type === 'credit_note' ? CREDIT_NOTE_STATUSES : INVOICE_STATUSES
  // An issued document keeps its number: it can be cancelled, never un-issued.
  const statuses = allStatuses.filter(s => !(doc.number && s === 'draft'))

  if (doc.status !== seenStatus) {
    setSeenStatus(doc.status)
    setStatus(doc.status)
  }

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Every status beyond draft/cancelled means the document has been issued, which requires a number.
  const needsNumber = (s: string) => !doc.number && s !== 'draft' && s !== 'cancelled'
  // "Paid" on an invoice goes through the server, which records the open balance as a payment.
  const recordsPayment = (s: string) => s === 'paid' && doc.type === 'invoice' && doc.status !== 'paid'
  // An issued invoice is cancelled with a Storno document, never by just flipping the status.
  const createsStorno = (s: string) => s === 'cancelled' && doc.type === 'invoice' && !!doc.number

  async function changeStatus(newStatus: string) {
    if (newStatus === status) { setOpen(false); return }
    if (DESTRUCTIVE.has(newStatus) || needsNumber(newStatus) || recordsPayment(newStatus)) {
      setConfirm(newStatus)
      setOpen(false)
      return
    }
    await applyStatus(newStatus)
  }

  async function applyStatus(newStatus: string) {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    try {
      if (createsStorno(newStatus)) {
        const res = await fetch(`/api/invoices/${doc.id}/convert-to-credit-note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cancel: true }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(data.error ?? 'Could not create the Storno'); return }
        setConfirm(null)
        toast.success('Invoice cancelled — issue the Storno and send it to the client.')
        router.push(`/credit-notes/${data.creditNoteId}`)
        return
      }
      if (recordsPayment(newStatus)) {
        const res = await fetch('/api/invoices/bulk', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: [doc.id], status: 'paid' }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(data.error ?? 'Could not mark as paid'); return }
        if (!data.updated) { toast.error('This invoice cannot be marked as paid in its current status.'); return }
      } else {
        if (needsNumber(newStatus)) {
          const { error: issueErr } = await supabase.rpc('issue_document', { p_document_id: doc.id })
          if (issueErr) { toast.error(issueErr.message); return }
        }
        const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)
        if (error) { toast.error(error.message); return }
      }
      setStatus(newStatus)
      setOpen(false)
      setConfirm(null)
      router.refresh()
      toast.success(recordsPayment(newStatus) ? 'Marked as paid — open balance recorded as a payment.' : `Status updated to ${newStatus}.`)
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const confirmText = (s: string) => {
    if (createsStorno(s)) return `Creates a Stornorechnung that cancels ${doc.number} and marks this invoice as cancelled. You then issue the Storno and send it to the client.`
    const parts: string[] = []
    if (needsNumber(s)) parts.push(`This assigns the next ${doc.type.replace('_', ' ')} number and marks the document as ${s}. Numbers cannot be taken back.`)
    if (recordsPayment(s)) parts.push('The open balance is recorded as a payment dated today.')
    if (DESTRUCTIVE.has(s)) parts.push('This action is hard to reverse.')
    return parts.join(' ')
  }

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${statusColor[status] ?? ''}`}
      >
        {status}
        <ChevronDown size={11} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1.5 z-10 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg py-1 min-w-36 overflow-hidden">
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => changeStatus(s)}
              className={`w-full text-left px-3 py-1.5 text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center justify-between gap-2
                ${s === status ? 'font-medium' : ''}
                ${itemColor[s] ?? 'text-neutral-700 dark:text-neutral-300'}`}
            >
              {s}
              {s === status && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />}
            </button>
          ))}
        </div>
      )}

      {confirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="bg-white dark:bg-neutral-900 rounded-xl border border-neutral-200 dark:border-neutral-700 shadow-xl p-6 max-w-sm w-full mx-4 space-y-4">
            <div>
              <h3 className="font-semibold text-neutral-900 dark:text-neutral-100">Mark as {confirm}?</h3>
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">{confirmText(confirm)}</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirm(null)} disabled={busy} className="text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button onClick={() => applyStatus(confirm)} disabled={busy} className="text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors disabled:opacity-50">
                {busy ? 'Working…' : 'Confirm'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
