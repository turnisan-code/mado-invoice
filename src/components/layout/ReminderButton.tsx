'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Bell, BellRing } from 'lucide-react'
import { toastApiError } from '@/lib/google/toast'
import { nextReminderLevel, reminderTitle } from '@/lib/utils/reminder-templates'

interface Props {
  documentId: string
  reminderSentAt: string | null
  reminderLevel: number
  maxLevel: number
  gmailConfigured: boolean
  generatePdf?: () => Promise<{ base64: string; filename: string } | null>
}

export default function ReminderButton({ documentId, reminderSentAt, reminderLevel, maxLevel, gmailConfigured, generatePdf }: Props) {
  const [sending, setSending] = useState(false)
  const [sentAt, setSentAt] = useState(reminderSentAt)
  const [level, setLevel] = useState(reminderLevel)
  const router = useRouter()

  if (!gmailConfigured) return null

  const nextLevel = nextReminderLevel(level, maxLevel)
  const nextTitle = reminderTitle(nextLevel, 'de')

  async function sendReminder() {
    setSending(true)
    let pdfBase64: string | undefined
    let filename: string | undefined
    if (generatePdf) {
      const pdf = await generatePdf()
      if (pdf) { pdfBase64 = pdf.base64; filename = pdf.filename }
    }
    const res = await fetch(`/api/invoices/${documentId}/reminder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdfBase64, filename }),
    })
    setSending(false)
    if (!res.ok) {
      toastApiError(await res.json().catch(() => ({})), 'Could not send reminder: ', 'Failed')
      return
    }
    const { sentAt: ts, level: sentLevel } = await res.json()
    setSentAt(ts)
    setLevel(sentLevel)
    toast.success(`${reminderTitle(sentLevel, 'de')} sent.`)
    router.refresh()
  }

  if (sentAt) {
    const date = new Date(sentAt).toLocaleDateString('de-AT', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-neutral-400 dark:text-neutral-500">
          <BellRing size={13} />
          <span className="hidden sm:inline">{reminderTitle(level, 'de')} sent {date}</span>
        </span>
        <button
          onClick={sendReminder}
          disabled={sending}
          title={`Send ${nextTitle} (last reminder ${date})`}
          className="text-xs text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors disabled:opacity-50"
        >
          {sending ? 'Sending…' : `Send ${nextTitle}`}
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
      <span className="hidden sm:inline">{sending ? 'Sending…' : `Send ${nextTitle}`}</span>
    </button>
  )
}
