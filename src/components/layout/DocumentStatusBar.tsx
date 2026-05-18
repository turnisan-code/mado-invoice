'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'cancelled'] as const
const QUOTE_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'cancelled'] as const

const statusColor: Record<string, string> = {
  draft: 'text-neutral-500 bg-neutral-100 border-neutral-200',
  sent: 'text-blue-700 bg-blue-50 border-blue-200',
  paid: 'text-green-700 bg-green-50 border-green-200',
  overdue: 'text-red-700 bg-red-50 border-red-200',
  accepted: 'text-green-700 bg-green-50 border-green-200',
  rejected: 'text-red-700 bg-red-50 border-red-200',
  cancelled: 'text-neutral-400 bg-neutral-50 border-neutral-200',
}

interface Props {
  document: { id: string; status: string; type: string }
}

export default function DocumentStatusBar({ document: doc }: Props) {
  const [status, setStatus] = useState(doc.status)
  const [open, setOpen] = useState(false)

  useEffect(() => { setStatus(doc.status) }, [doc.status])
  const router = useRouter()
  const supabase = createClient()
  const statuses = doc.type === 'quote' ? QUOTE_STATUSES : INVOICE_STATUSES

  async function changeStatus(newStatus: string) {
    const { error } = await supabase.from('documents').update({ status: newStatus }).eq('id', doc.id)
    if (error) { toast.error(error.message); return }
    setStatus(newStatus)
    setOpen(false)
    router.refresh()
    toast.success(`Status → ${newStatus}`)
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`text-xs px-2.5 py-1 rounded-full border font-medium transition-colors ${statusColor[status] ?? ''}`}
      >
        {status} ▾
      </button>
      {open && (
        <div className="absolute top-full left-0 mt-1 z-10 bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-700 rounded-lg shadow-md py-1 min-w-32">
          {statuses.map(s => (
            <button
              key={s}
              onClick={() => changeStatus(s)}
              className={`w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors ${s === status ? 'font-medium' : ''}`}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
