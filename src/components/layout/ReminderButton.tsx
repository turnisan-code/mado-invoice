'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Bell, BellRing } from 'lucide-react'
import { toastApiError } from '@/lib/google/toast'
import { nextReminderLevel, reminderTitle } from '@/lib/utils/reminder-templates'
import { formatDate } from '@/lib/utils/document'
import { useT } from '@/lib/i18n/client'

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
  const { t, lang } = useT()

  if (!gmailConfigured) return null

  const nextLevel = nextReminderLevel(level, maxLevel)
  const nextTitle = reminderTitle(nextLevel, lang)

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
      toastApiError(t, await res.json().catch(() => ({})), t('reminders.couldNotSend'), t('common.failed'))
      return
    }
    const { sentAt: ts, level: sentLevel } = await res.json()
    setSentAt(ts)
    setLevel(sentLevel)
    toast.success(t('reminders.sent', { title: reminderTitle(sentLevel, lang) }))
    router.refresh()
  }

  if (sentAt) {
    const date = formatDate(sentAt, lang)
    const shortDate = new Date(sentAt).toLocaleDateString(lang === 'de' ? 'de-AT' : 'en-GB', { day: '2-digit', month: '2-digit' })
    return (
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          <BellRing size={13} aria-hidden="true" />
          <span className="sm:hidden">{t('reminders.sentShort', { date: shortDate })}</span>
          <span className="hidden sm:inline">{t('reminders.sentLong', { title: reminderTitle(level, lang), date })}</span>
        </span>
        <button
          type="button"
          onClick={sendReminder}
          disabled={sending}
          title={t('reminders.sendNextTitle', { title: nextTitle, date })}
          className="text-xs px-2 py-2 -my-2 rounded-md text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors disabled:opacity-50"
        >
          {sending ? t('common.sending') : t('reminders.sendNext', { title: nextTitle })}
        </button>
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={sendReminder}
      disabled={sending}
      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-md border border-neutral-200 dark:border-neutral-700 hover:bg-neutral-50 dark:hover:bg-neutral-800 transition-colors disabled:opacity-50"
    >
      <Bell size={14} aria-hidden="true" />
      <span className="sr-only sm:not-sr-only">{sending ? t('common.sending') : t('reminders.sendNext', { title: nextTitle })}</span>
    </button>
  )
}
