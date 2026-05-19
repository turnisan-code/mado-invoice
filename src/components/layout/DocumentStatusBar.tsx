'use client'

import { useState, useEffect, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'
import { ChevronDown } from 'lucide-react'

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'cancelled'] as const

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
  document: { id: string; status: string; type: string }
}

export default function DocumentStatusBar({ document: doc }: Props) {
  const [status, setStatus] = useState(doc.status)
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const router = useRouter()
  const supabase = createClient()
  const statuses = doc.type === 'quote' ? QUOTE_STATUSES : INVOICE_STATUSES

  useEffect(() => { setStatus(doc.status) }, [doc.status])

  useEffect(() => {
    if (!open) return
    function handler(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  async function changeStatus(newStatus: string) {
    if (DESTRUCTIVE.has(newStatus) && newStatus !== status) {
      setConfirm(newStatus)
      setOpen(false)
      return
    }
    await applyStatus(newStatus)
  }

  async function applyStatus(newStatus: string) {
    const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)
    if (error) { toast.error(error.message); return }
    setStatus(newStatus)
    setOpen(false)
    setConfirm(null)
    router.refresh()
    toast.success(`Status updated to ${newStatus}.`)
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
              <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">This action is hard to reverse.</p>
            </div>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirm(null)} className="text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors">
                Cancel
              </button>
              <button onClick={() => applyStatus(confirm)} className="text-sm px-3 py-1.5 rounded-md bg-neutral-900 dark:bg-white text-white dark:text-neutral-900 hover:bg-neutral-700 dark:hover:bg-neutral-100 transition-colors">
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
