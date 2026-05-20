'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Bell, BellRing } from 'lucide-react'

interface Props {
  documentId: string
  reminderSentAt: string | null
  gmailConfigured: boolean
}

export default function ReminderButton({ documentId, reminderSentAt, gmailConfigured }: Props) {
  const [sending, setSending] = useState(false)
  const [sentAt, setSentAt] = useState(reminderSentAt)

  if (!gmailConfigured) return null

  async function sendReminder() {
    setSending(true)
    const res = await fetch(`/api/invoices/${documentId}/reminder`, { method: 'POST' })
    setSending(false)
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: 'Failed' }))
      toast.error(`Could not send reminder: ${error}`)
      return
    }
    const { sentAt: ts } = await res.json()
    setSentAt(ts)
    toast.success('Reminder sent.')
  }

  if (sentAt) {
    const date = new Date(sentAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
          <BellRing size={13} /> Reminder sent {date}
        </span>
        <button
          onClick={sendReminder}
          disabled={sending}
          className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors disabled:opacity-50"
        >
          {sending ? 'Sending…' : 'Resend'}
        </button>
      </div>
    )
  }

  return (
    <button
      onClick={sendReminder}
      disabled={sending}
      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
    >
      <Bell size={14} />
      {sending ? 'Sending…' : 'Send reminder'}
    </button>
  )
}
