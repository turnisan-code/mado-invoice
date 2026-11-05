'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'
import { ConfirmDialog } from '@/components/ui/ConfirmDialog'
import { toastApiError } from '@/lib/google/toast'
import { logEvent } from '@/lib/events'
import { flushPendingEdits } from '@/lib/issued-pdf'
import { useT } from '@/lib/i18n/client'
import type { DictKey } from '@/lib/i18n'

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
  cancelled: 'text-neutral-500 bg-neutral-50 border-neutral-200 dark:bg-neutral-800 dark:border-neutral-700 dark:text-neutral-400',
}

const itemColor: Record<string, string> = {
  paid:      'text-green-700 dark:text-green-400',
  overdue:   'text-red-600 dark:text-red-400',
  accepted:  'text-green-700 dark:text-green-400',
  rejected:  'text-red-600 dark:text-red-400',
  cancelled: 'text-neutral-500 dark:text-neutral-400',
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
  const { t } = useT()
  const allStatuses: readonly string[] = doc.type === 'quote' ? QUOTE_STATUSES : doc.type === 'credit_note' ? CREDIT_NOTE_STATUSES : INVOICE_STATUSES
  // An issued document keeps its number: it can be cancelled, never un-issued.
  const statuses = allStatuses.filter(s => !(doc.number && s === 'draft'))
  const statusLabel = (s: string) => t(`status.${s}` as DictKey)

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
      // Issuing renders the frozen PDF from the database, so the builder's pending edits go first.
      if (needsNumber(newStatus) || (recordsPayment(newStatus) && !doc.number)) await flushPendingEdits(doc.id)
      if (createsStorno(newStatus)) {
        const res = await fetch(`/api/invoices/${doc.id}/convert-to-credit-note`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ cancel: true }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) { toast.error(data.error ?? t('statusBar.stornoFailed')); return }
        setConfirm(null)
        toast.success(t('statusBar.invoiceCancelled'))
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
        if (!res.ok) { toast.error(data.error ?? t('statusBar.markPaidFailed')); return }
        if (!data.updated) { toast.error(t('statusBar.cannotMarkPaid')); return }
        await logEvent(supabase, doc.id, 'status_changed', { from: status, to: newStatus })
      } else {
        // Issuing (number, archive copy, Drive) runs on the server and moves a draft to 'sent'.
        let from = status
        if (needsNumber(newStatus)) {
          const res = await fetch(`/api/documents/${doc.id}/issue`, { method: 'POST' })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) { toast.error(data.error ?? t('common.unknownError')); return }
          if (data.snapshotError) toast.error(t('builder.snapshotFailed', { error: data.snapshotError }))
          if (data.driveError) toastApiError(t, data.driveError, t('builder.driveFailedPrefix'))
          if (from === 'draft') from = 'sent'
        }
        if (newStatus !== from) {
          const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)
          if (error) { toast.error(error.message); return }
          await logEvent(supabase, doc.id, 'status_changed', { from, to: newStatus })
        }
      }
      setStatus(newStatus)
      setOpen(false)
      setConfirm(null)
      router.refresh()
      toast.success(recordsPayment(newStatus) ? t('statusBar.markedPaid') : t('statusBar.statusUpdated', { status: statusLabel(newStatus) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }

  const confirmText = (s: string) => {
    if (createsStorno(s)) return t('statusBar.confirmStorno', { number: doc.number ?? '' })
    const parts: string[] = []
    if (needsNumber(s)) parts.push(t('statusBar.confirmNumber', { number: t(`docTypeNumber.${doc.type}` as DictKey), status: statusLabel(s) }))
    if (recordsPayment(s)) parts.push(t('statusBar.confirmPayment'))
    if (DESTRUCTIVE.has(s)) parts.push(t('statusBar.confirmDestructive'))
    return parts.join(' ')
  }

  return (
    <div className="relative" ref={ref} onKeyDown={e => { if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false) } }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('statusBar.statusAria', { status: statusLabel(status) })}
        className={`flex items-center gap-1 text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${statusColor[status] ?? ''}`}
      >
        {statusLabel(status)}
        <ChevronDown size={11} className={`transition-transform duration-150 ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div role="menu" aria-label={t('statusBar.changeStatus')} className="absolute top-full left-0 mt-1.5 z-10 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-lg py-1 min-w-36 overflow-hidden">
          {statuses.map(s => (
            <button
              key={s}
              type="button"
              role="menuitem"
              aria-current={s === status ? 'true' : undefined}
              onClick={() => changeStatus(s)}
              className={`w-full text-left px-3 py-2 sm:py-1.5 text-sm transition-colors hover:bg-neutral-50 dark:hover:bg-neutral-800 flex items-center justify-between gap-2
                ${s === status ? 'font-medium' : ''}
                ${itemColor[s] ?? 'text-neutral-700 dark:text-neutral-300'}`}
            >
              {statusLabel(s)}
              {s === status && <span className="w-1.5 h-1.5 rounded-full bg-current opacity-60" />}
            </button>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={!!confirm}
        title={confirm ? t('statusBar.markAsTitle', { status: statusLabel(confirm) }) : ''}
        description={confirm ? confirmText(confirm) : undefined}
        confirmLabel={busy ? t('common.working') : t('common.confirm')}
        destructive={!!confirm && DESTRUCTIVE.has(confirm)}
        busy={busy}
        onConfirm={() => { if (confirm) void applyStatus(confirm) }}
        onCancel={() => setConfirm(null)}
      />
    </div>
  )
}
